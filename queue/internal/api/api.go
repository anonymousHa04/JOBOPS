// Package api is the queue's HTTP interface (loopback only; see cmd/queue).
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
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
type seen struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (k *seen) mark(worker string) {
	group, _, _ := strings.Cut(worker, "-")
	if group == "" {
		return
	}
	k.mu.Lock()
	k.last[group] = time.Now().UTC()
	k.mu.Unlock()
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
	workers := &seen{last: map[string]time.Time{}}

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
		send(w, http.StatusOK, map[string]int64{"batch_id": id, "queued": int64(n)})
	})

	mux.HandleFunc("POST /rescore", func(w http.ResponseWriter, r *http.Request) {
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
		id, err := s.Rescore(in.JobID)
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
		finish(w, s.Done(id, in.Result))
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
		finish(w, s.Fail(id, in.Code, in.Detail))
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
