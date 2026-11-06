// Package api is the queue's HTTP interface (loopback only; see cmd/queue).
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"jobops/queue/internal/store"
)

var stages = map[string]bool{"fetch": true, "parse": true, "score": true, "tailor": true}

// seen: when each worker group (laptop, mac) last asked for work or pinged. In memory only:
// the health bar uses it where pgrep cannot see the workers (each runs in its own pod).
// The log gets a line when a worker comes up or comes back, and when it goes quiet (watchQuiet),
// never one per heartbeat.
type seen struct {
	mu    sync.Mutex
	last  map[string]time.Time
	quiet map[string]bool // reported quiet; the next heartbeat logs "back"
}

// quietAfter: no heartbeat or lease for this long counts as quiet (workers ping every ~30 s).
const quietAfter = 90 * time.Second

func (k *seen) mark(worker string) {
	group, _, _ := strings.Cut(worker, "-")
	if group == "" {
		return
	}
	k.mu.Lock()
	_, known := k.last[group]
	wasQuiet := k.quiet[group]
	k.last[group] = time.Now().UTC()
	delete(k.quiet, group)
	k.mu.Unlock()
	switch {
	case !known:
		log.Printf("worker %s up (%s)", group, worker)
	case wasQuiet:
		log.Printf("worker %s back (%s)", group, worker)
	}
}

// watchQuiet logs each worker group that stops sending heartbeats, once until it is back.
func (k *seen) watchQuiet(every time.Duration) {
	for range time.Tick(every) {
		now := time.Now().UTC()
		k.mu.Lock()
		for g, t := range k.last {
			if now.Sub(t) > quietAfter && !k.quiet[g] {
				k.quiet[g] = true
				log.Printf("worker %s quiet: no heartbeat for %s", g, now.Sub(t).Round(time.Second))
			}
		}
		k.mu.Unlock()
	}
}

func (k *seen) all() map[string]string {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := make(map[string]string, len(k.last))
	for g, t := range k.last {
		out[g] = t.Format(time.RFC3339)
	}
	return out
}

func Handler(s *store.Store) http.Handler {
	mux := http.NewServeMux()
	workers := &seen{last: map[string]time.Time{}, quiet: map[string]bool{}}
	go workers.watchQuiet(30 * time.Second)

	// The change feed (Server-Sent Events): the API relays it to the UI; workers wait on it.
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
		if s.Events == nil {
			fail(w, http.StatusServiceUnavailable, "events are off")
			return
		}
		s.Events.ServeSSE(w, r)
	})

	mux.HandleFunc("POST /workers/ping", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Worker string `json:"worker"`
		}
		if !read(w, r, &in) {
			return
		}
		workers.mark(in.Worker)
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /workers", func(w http.ResponseWriter, r *http.Request) {
		send(w, http.StatusOK, workers.all())
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		send(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /batches", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Limit        int    `json:"limit"`
			ParseVersion string `json:"parse_version"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.ParseVersion == "" {
			fail(w, http.StatusBadRequest, "parse_version is required")
			return
		}
		id, err := s.StartBatch(in.Limit, in.ParseVersion)
		if errors.Is(err, store.ErrBadLimit) {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("batch %d started (limit %d, parse %s)", id, in.Limit, in.ParseVersion)
		send(w, http.StatusCreated, map[string]int64{"batch_id": id})
	})

	mux.HandleFunc("GET /batches", func(w http.ResponseWriter, r *http.Request) {
		out, err := s.Batches(20)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		send(w, http.StatusOK, out)
	})

	mux.HandleFunc("GET /batches/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		b, err := s.Batch(id)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, http.StatusNotFound, "no such batch")
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		send(w, http.StatusOK, b)
	})

	mux.HandleFunc("POST /batches/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		n, err := s.RetryBatch(id)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("batch %d retry: %d tasks requeued", id, n)
		send(w, http.StatusOK, map[string]int{"requeued": n})
	})

	// Score leftovers now (parsed jobs no batch has scored); the server also does this on a timer.
	mux.HandleFunc("POST /sweep", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Max int `json:"max"`
		}
		if !read(w, r, &in) {
			return
		}
		id, n, err := s.Sweep(in.Max)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if n > 0 {
			log.Printf("sweep (asked): batch %d queued %d parsed jobs for scoring", id, n)
		}
		send(w, http.StatusOK, map[string]int64{"batch_id": id, "queued": int64(n)})
	})

	mux.HandleFunc("POST /rescore", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			JobID  string   `json:"job_id"`
			JobIDs []string `json:"job_ids"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.JobID == "" && len(in.JobIDs) == 0 {
			fail(w, http.StatusBadRequest, "job_id or job_ids is required")
			return
		}
		if in.JobID == "" {
			id, n, err := s.RescoreJobs(in.JobIDs)
			if err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
			log.Printf("rescore: batch %d queued %d of %d jobs", id, n, len(in.JobIDs))
			send(w, http.StatusOK, map[string]int64{"batch_id": id, "queued": int64(n)})
			return
		}
		id, err := s.Rescore(in.JobID)
		if errors.Is(err, store.ErrNotParsed) {
			fail(w, http.StatusConflict, "job not parsed")
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("rescore: job %s, batch %d", short(in.JobID), id)
		send(w, http.StatusOK, map[string]int64{"batch_id": id})
	})

	// A job the user added by its link (UI): parse it (unless parsed) and score it; no tailor.
	mux.HandleFunc("POST /add", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			JobID string `json:"job_id"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.JobID == "" {
			fail(w, http.StatusBadRequest, "job_id is required")
			return
		}
		id, stage, err := s.Add(in.JobID)
		if errors.Is(err, store.ErrBusy) {
			fail(w, http.StatusConflict, "job already has an open task")
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("add: job %s, batch %d, %s queued", short(in.JobID), id, stage)
		send(w, http.StatusOK, map[string]any{"batch_id": id, "stage": stage})
	})

	mux.HandleFunc("POST /tailor", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			JobID string `json:"job_id"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.JobID == "" {
			fail(w, http.StatusBadRequest, "job_id is required")
			return
		}
		id, err := s.Tailor(in.JobID)
		if err == nil {
			log.Printf("tailor: job %s, batch %d", short(in.JobID), id)
		}
		if errors.Is(err, store.ErrNotParsed) {
			fail(w, http.StatusConflict, "job not parsed")
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		send(w, http.StatusOK, map[string]int64{"batch_id": id})
	})

	// The user deleted a job (UI): drop its tasks and filter row.
	mux.HandleFunc("POST /forget", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			JobID string `json:"job_id"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.JobID == "" {
			fail(w, http.StatusBadRequest, "job_id is required")
			return
		}
		n, err := s.Forget(in.JobID)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		log.Printf("forget: job %s (%d tasks removed)", short(in.JobID), n)
		send(w, http.StatusOK, map[string]int{"removed": n})
	})

	mux.HandleFunc("POST /lease", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Stages []string `json:"stages"`
			Worker string   `json:"worker"`
		}
		if !read(w, r, &in) {
			return
		}
		if len(in.Stages) == 0 {
			fail(w, http.StatusBadRequest, "stages is required")
			return
		}
		for _, st := range in.Stages {
			if !stages[st] {
				fail(w, http.StatusBadRequest, "unknown stage: "+st)
				return
			}
		}
		workers.mark(in.Worker)
		t, err := s.Lease(in.Stages, in.Worker)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if t == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		log.Printf("task %d leased: %s job %s, batch %d, attempt %d, by %s", t.ID, t.Stage, short(t.JobID), t.BatchID, t.Attempts, in.Worker)
		send(w, http.StatusOK, t)
	})

	mux.HandleFunc("POST /tasks/{id}/done", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		var in struct {
			Result json.RawMessage `json:"result"`
		}
		if !read(w, r, &in) {
			return
		}
		err := s.Done(id, in.Result)
		if err == nil {
			log.Printf("task %d done%s", id, summary(in.Result))
		}
		finish(w, err)
	})

	mux.HandleFunc("POST /tasks/{id}/fail", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		var in struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
		}
		if !read(w, r, &in) {
			return
		}
		if in.Code == "" {
			fail(w, http.StatusBadRequest, "code is required")
			return
		}
		err := s.Fail(id, in.Code, in.Detail)
		if err == nil {
			log.Printf("task %d failed: %s %s", id, in.Code, clip(in.Detail, 200))
		}
		finish(w, err)
	})

	return mux
}

func finish(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotLeased):
		fail(w, http.StatusConflict, err.Error())
	case err != nil:
		fail(w, http.StatusInternalServerError, err.Error())
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// read decodes a JSON body of at most 64 KiB; on error it answers 400 and returns false.
func read(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		fail(w, http.StatusBadRequest, "id must be a positive integer")
		return 0, false
	}
	return id, true
}

func send(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	send(w, status, map[string]string{"error": msg})
}

// short: the first 8 characters of a job id, as the UI shows them.
func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// summary: the few result fields worth a log line (decision, score, resume id), never text.
func summary(raw json.RawMessage) string {
	var r struct {
		Decision *string  `json:"decision"`
		Score    *float64 `json:"score"`
		ResumeID *string  `json:"resume_id"`
		Fetched  *int     `json:"fetched"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &r) != nil {
		return ""
	}
	var parts []string
	if r.Decision != nil {
		parts = append(parts, *r.Decision)
	}
	if r.Score != nil {
		parts = append(parts, fmt.Sprintf("score %.1f", *r.Score))
	}
	if r.ResumeID != nil && *r.ResumeID != "" {
		parts = append(parts, "resume "+*r.ResumeID)
	}
	if r.Fetched != nil {
		parts = append(parts, fmt.Sprintf("fetched %d", *r.Fetched))
	}
	if len(parts) == 0 {
		return ""
	}
	return ": " + strings.Join(parts, ", ")
}
