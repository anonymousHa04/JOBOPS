// The JobOps queue server: one queue per stage (fetch, parse, score, tailor) in data/jobops.db.
// Node workers lease tasks over HTTP; the fetch stage runs here (jd-search). Loopback only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"jobops/queue/internal/api"
	"jobops/queue/internal/events"
	"jobops/queue/internal/fetch"
	"jobops/queue/internal/store"
)

func main() {
	root, err := repoRoot()
	if err != nil {
		log.Fatal(err)
	}
	dbPath := flag.String("db", env("JOBOPS_DB", "data/jobops.db"), "SQLite database (relative to the repo root)")
	addr := flag.String("addr", env("JOBOPS_QUEUE_ADDR", "127.0.0.1:8090"), "listen address (loopback only)")
	flag.Parse()

	// Loopback only, except inside the cluster (JOBOPS_IN_CLUSTER=1): pods reach it through a
	// ClusterIP Service, which nothing outside the cluster can reach.
	if !loopback(*addr) && os.Getenv("JOBOPS_IN_CLUSTER") != "1" {
		fmt.Fprintf(os.Stderr, "queue: refusing to listen on %s: use 127.0.0.1, ::1 or localhost\n", *addr)
		os.Exit(2)
	}
	path := *dbPath
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	s, err := store.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer s.Close()
	s.Events = events.NewHub()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go expireLoop(ctx, s)
	go fetchLoop(ctx, s, fetch.JDSearch(root), fetch.JDCheck(root))
	if every, err := time.ParseDuration(env("JOBOPS_SWEEP_EVERY", "2m")); err == nil && every > 0 {
		go sweepLoop(ctx, s, every)
	} else {
		log.Printf("sweep: off (JOBOPS_SWEEP_EVERY=%q)", os.Getenv("JOBOPS_SWEEP_EVERY"))
	}

	// BaseContext: stopping cancels every request's context, so open event streams end at once
	// and Shutdown does not wait for them.
	srv := &http.Server{Addr: *addr, Handler: api.HandlerWith(s, retryCompany(s, fetch.JDSearch(root))), ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()
	log.Printf("queue listening on http://%s (db %s)", *addr, path)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Parsed jobs that no batch scored (jd parse, job add, older parses) get scored without a manual
// batch: every JOBOPS_SWEEP_EVERY (default 2m, "0" turns it off), up to 50 per sweep. The score
// result decides tailoring as in any batch. Workers must be running to pick the tasks up.
func sweepLoop(ctx context.Context, s *store.Store, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if id, n, err := s.Sweep(50); err != nil {
			log.Printf("sweep: %v", err)
		} else if n > 0 {
			log.Printf("sweep: batch %d queued %d parsed jobs for scoring", id, n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Leases whose worker went away go back to the queue.
func expireLoop(ctx context.Context, s *store.Store) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.ExpireLeases(); err != nil {
				log.Printf("expire: %v", err)
			} else if n > 0 {
				log.Printf("expired %d leases", n)
			}
		}
	}
}

// Fetch tasks run here, each in its own goroutine (no limit): the search, then the preference
// check of every stored job a batch could take (a job saved by an older search is skipped once
// the preferences exclude it). A failed check fails the fetch task (code check_failed); the
// batch then uses the last saved verdicts. The run's per-company rows (searched, unreachable,
// no slug, excluded) are saved for the batch; the task result keeps only the counts. A batch
// that turned skip words off searches with them unskipped and gets a second check saved for
// that batch only (its skipped counts are the task's).
func fetchLoop(ctx context.Context, s *store.Store, run fetch.Runner, check fetch.Checker) {
	// Wakes when a fetch task is queued (a batch started or retried, a fetch retried); the
	// timer is only a fallback, for a retry whose backoff ends with no event.
	feed, cancel := s.Events.Subscribe()
	defer func() { cancel() }()
	fallback := time.NewTimer(0)
	defer fallback.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-feed:
			if !ok { // dropped (fell behind): subscribe again, and look now
				feed, cancel = s.Events.Subscribe()
			} else if !(e.State == "queued" && (e.Stage == "fetch" || (e.Kind == "batch" && e.Stage == ""))) {
				continue
			}
		case <-fallback.C:
		}
		fallback.Reset(30 * time.Second)
		for {
			task, err := s.Lease([]string{"fetch"}, "queue-fetch")
			if err != nil {
				log.Printf("lease fetch: %v", err)
				break
			}
			if task == nil {
				break
			}
			log.Printf("batch %d task %d fetch leased", task.BatchID, task.ID)
			go func(task *store.Task) {
				unskip, err := s.BatchUnskip(task.BatchID)
				if err != nil {
					if ferr := s.Fail(task.ID, "fetch_failed", err.Error()); ferr != nil {
						log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
					}
					log.Printf("batch %d task %d fetch failed: %v", task.BatchID, task.ID, err)
					return
				}
				var sum fetch.Summary
				if len(unskip) > 0 {
					sum, err = run(ctx, "--unskip", strings.Join(unskip, ","))
				} else {
					sum, err = run(ctx)
				}
				if err != nil {
					if ferr := s.Fail(task.ID, "fetch_failed", err.Error()); ferr != nil {
						log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
					}
					log.Printf("batch %d task %d fetch failed", task.BatchID, task.ID)
					return
				}
				if serr := s.SaveCompanies(task.BatchID, sum.Companies); serr != nil {
					log.Printf("batch %d task %d save companies: %v", task.BatchID, task.ID, serr)
				}
				sum.Companies = nil
				skipped, err := fetch.Recheck(ctx, s, check)
				if err != nil {
					if ferr := s.Fail(task.ID, "check_failed", err.Error()); ferr != nil {
						log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
					}
					log.Printf("batch %d task %d preference check failed: %v", task.BatchID, task.ID, err)
					return
				}
				if len(unskip) > 0 {
					skipped, err = fetch.RecheckBatch(ctx, s, check, task.BatchID, unskip)
					if err != nil {
						if ferr := s.Fail(task.ID, "check_failed", err.Error()); ferr != nil {
							log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
						}
						log.Printf("batch %d task %d batch preference check failed: %v", task.BatchID, task.ID, err)
						return
					}
				}
				sum.Skipped = skipped
				b, _ := json.Marshal(sum)
				if derr := s.Done(task.ID, b); derr != nil {
					log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, derr)
					return
				}
				log.Printf("batch %d task %d fetch done (matched %d, new %d, skipped %v)", task.BatchID, task.ID, sum.Matched, sum.Created, sum.Skipped)
			}(task)
		}
	}
}

// retryCompany searches one company of a batch again (jd-search --only, with an optional new
// slug and ats, and the batch's unskipped words), saves its row, and queues the batch's next
// jobs when the search added any.
func retryCompany(s *store.Store, run fetch.Runner) api.RetryFunc {
	return func(ctx context.Context, batchID int64, name, slug, ats string) (store.Company, error) {
		unskip, err := s.BatchUnskip(batchID)
		if err != nil {
			return store.Company{}, err
		}
		args := []string{"--only", name}
		if slug != "" {
			args = append(args, "--slug", slug)
		}
		if ats != "" {
			args = append(args, "--ats", ats)
		}
		if len(unskip) > 0 {
			args = append(args, "--unskip", strings.Join(unskip, ","))
		}
		sum, err := run(ctx, args...)
		if err != nil {
			return store.Company{}, err
		}
		var row *store.Company
		for i := range sum.Companies {
			if strings.EqualFold(sum.Companies[i].Name, name) {
				row = &sum.Companies[i]
				break
			}
		}
		if row == nil {
			return store.Company{}, fmt.Errorf("jd-search returned no row for %s", name)
		}
		if err := s.UpsertCompany(batchID, *row); err != nil {
			return store.Company{}, err
		}
		if row.Created > 0 {
			ids, err := s.QueueMore(batchID)
			if err != nil {
				log.Printf("batch %d retry %s: %v", batchID, name, err)
			} else {
				log.Printf("batch %d retry %s: queued %d jobs", batchID, name, len(ids))
			}
		}
		return *row, nil
	}
}

func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// repoRoot: JOBOPS_ROOT when set (the container image has no .git), else the nearest folder with .git.
func repoRoot() (string, error) {
	if root := os.Getenv("JOBOPS_ROOT"); root != "" {
		return root, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("queue: run it inside the JobOps repo (no .git found)")
		}
		dir = parent
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
