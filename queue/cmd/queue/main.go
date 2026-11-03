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
	"syscall"
	"time"

	"jobops/queue/internal/api"
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

	if !loopback(*addr) {
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go expireLoop(ctx, s)
	go fetchLoop(ctx, s, fetch.JDSearch(root), fetch.JDCheck(root))

	srv := &http.Server{Addr: *addr, Handler: api.Handler(s), ReadHeaderTimeout: 10 * time.Second}
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
// batch then uses the last saved verdicts.
func fetchLoop(ctx context.Context, s *store.Store, run fetch.Runner, check fetch.Checker) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
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
				sum, err := run(ctx)
				if err != nil {
					if ferr := s.Fail(task.ID, "fetch_failed", err.Error()); ferr != nil {
						log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
					}
					log.Printf("batch %d task %d fetch failed", task.BatchID, task.ID)
					return
				}
				skipped, err := fetch.Recheck(ctx, s, check)
				if err != nil {
					if ferr := s.Fail(task.ID, "check_failed", err.Error()); ferr != nil {
						log.Printf("batch %d task %d fetch: %v", task.BatchID, task.ID, ferr)
					}
					log.Printf("batch %d task %d preference check failed: %v", task.BatchID, task.ID, err)
					return
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

func repoRoot() (string, error) {
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
