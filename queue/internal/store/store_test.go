package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// clock is a fake time source; tests move it by assigning c.t.
type clock struct{ t time.Time }

func newStore(t *testing.T) (*Store, *clock) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "q.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.db.Exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	c := &clock{t: time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)}
	s.now = func() time.Time { return c.t }
	return s, c
}

// addJobs inserts job-01..job-NN, each one minute newer than the last.
func addJobs(t *testing.T, s *Store, n int) {
	t.Helper()
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i := 1; i <= n; i++ {
		if _, err := s.db.Exec(`INSERT INTO jobs (id, first_seen_at) VALUES (?, ?)`,
			fmt.Sprintf("job-%02d", i), base.Add(time.Duration(i)*time.Minute).Format(time.RFC3339)); err != nil {
			t.Fatal(err)
		}
	}
}

// must panics on an error (the test fails with its message); it takes a call's two results.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// startFetched starts a batch and finishes its fetch task, so its jobs are queued.
func startFetched(t *testing.T, s *Store, limit int, version string) int64 {
	t.Helper()
	id := must(s.StartBatch(limit, version))
	f := must(s.Lease([]string{"fetch"}, "test"))
	if f == nil || f.Stage != "fetch" {
		t.Fatalf("fetch task not leased: %+v", f)
	}
	if err := s.Done(f.ID, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	return id
}

type row struct {
	JobID, Stage, State, Version, Code string
	Attempts, Final                    int
	RetryAt                            sql.NullString
}

func tasks(t *testing.T, s *Store, where string, args ...any) []row {
	t.Helper()
	rs, err := s.db.Query(`SELECT job_id, stage, state, prompt_version, COALESCE(error_code, ''), attempts, final, retry_at
		FROM queue_tasks WHERE `+where+` ORDER BY id`, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []row
	for rs.Next() {
		var r row
		if err := rs.Scan(&r.JobID, &r.Stage, &r.State, &r.Version, &r.Code, &r.Attempts, &r.Final, &r.RetryAt); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func leaseJob(t *testing.T, s *Store, stage, job string) *Task {
	t.Helper()
	var id int64
	if err := s.db.QueryRow(`SELECT id FROM queue_tasks WHERE stage = ? AND job_id = ?`, stage, job).Scan(&id); err != nil {
		t.Fatal(err)
	}
	// Lease takes the oldest ready task: lease until this one comes up, then put the rest back.
	var others []int64
	defer func() {
		for _, o := range others {
			s.db.Exec(`UPDATE queue_tasks SET state = 'queued', attempts = attempts - 1 WHERE id = ?`, o)
		}
	}()
	for {
		task := must(s.Lease([]string{stage}, "test"))
		if task == nil {
			t.Fatalf("task %s/%s never leased", stage, job)
		}
		if task.ID == id {
			return task
		}
		others = append(others, task.ID)
	}
}

func TestStore(t *testing.T) {
	t.Run("1 StartBatch limits and the fetch task", func(t *testing.T) {
		s, _ := newStore(t)
		id := must(s.StartBatch(0, "v1"))
		var limit int
		if err := s.db.QueryRow(`SELECT limit_n FROM queue_batches WHERE id = ?`, id).Scan(&limit); err != nil || limit != 100 {
			t.Fatalf("limit = %d, %v; want 100", limit, err)
		}
		for _, bad := range []int{101, -1} {
			if _, err := s.StartBatch(bad, "v1"); !errors.Is(err, ErrBadLimit) {
				t.Fatalf("StartBatch(%d) err = %v, want ErrBadLimit", bad, err)
			}
		}
		got := tasks(t, s, "batch_id = ?", id)
		if len(got) != 1 || got[0].Stage != "fetch" || got[0].State != "queued" || got[0].JobID != fmt.Sprintf("batch:%d", id) {
			t.Fatalf("tasks = %+v", got)
		}
	})

	t.Run("2 fetch done queues the newest jobs", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 5)
		startFetched(t, s, 3, "v1")
		got := tasks(t, s, "stage = 'parse'")
		want := []string{"job-05", "job-04", "job-03"}
		if len(got) != 3 {
			t.Fatalf("parse tasks = %+v", got)
		}
		for i, r := range got {
			if r.JobID != want[i] || r.Version != "v1" || r.State != "queued" {
				t.Fatalf("parse task %d = %+v, want %s v1 queued", i, r, want[i])
			}
		}
	})

	t.Run("3 a second batch skips active and finished jobs, re-queues failed ones", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 5)
		startFetched(t, s, 3, "v1") // job-05, job-04, job-03
		// job-05 fails for good, job-04 finishes (score not_tailored), job-03 stays queued.
		p5 := leaseJob(t, s, "parse", "job-05")
		if err := s.Fail(p5.ID, "invalid_output", "x"); err != nil {
			t.Fatal(err)
		}
		p4 := leaseJob(t, s, "parse", "job-04")
		if err := s.Done(p4.ID, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
		s4 := leaseJob(t, s, "score", "job-04")
		if err := s.Done(s4.ID, json.RawMessage(`{"decision":"not_tailored"}`)); err != nil {
			t.Fatal(err)
		}
		b2 := startFetched(t, s, 3, "v1")
		re := tasks(t, s, "job_id = 'job-05' AND stage = 'parse'")
		if len(re) != 1 || re[0].State != "queued" || re[0].Attempts != 0 {
			t.Fatalf("job-05 not re-queued: %+v", re)
		}
		if n := len(tasks(t, s, "job_id = 'job-04' AND state = 'queued'")); n != 0 {
			t.Fatalf("finished job-04 queued again (%d tasks)", n)
		}
		if n := len(tasks(t, s, "job_id = 'job-03'")); n != 1 {
			t.Fatalf("active job-03 has %d tasks, want 1", n)
		}
		// Batch 2 took job-05 (re-queued), job-02 and job-01 (new).
		got := tasks(t, s, "batch_id = ? AND stage = 'parse'", b2)
		ids := map[string]bool{}
		for _, r := range got {
			ids[r.JobID] = true
		}
		if len(got) != 3 || !ids["job-05"] || !ids["job-02"] || !ids["job-01"] {
			t.Fatalf("batch 2 parse tasks = %+v", got)
		}
	})

	t.Run("4 group limits and stage order", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 5)
		startFetched(t, s, 5, "v1")
		for i := 0; i < 3; i++ {
			if must(s.Lease([]string{"parse"}, "test")) == nil {
				t.Fatalf("lease %d returned nil", i+1)
			}
		}
		if task := must(s.Lease([]string{"parse"}, "test")); task != nil {
			t.Fatalf("4th laptop lease = %+v, want nil", task)
		}
		// Tailor has its own limit.
		now := s.ts(0)
		if _, err := s.db.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, state, created_at, updated_at)
			VALUES (1, 'job-99', 'tailor', 'queued', ?, ?)`, now, now); err != nil {
			t.Fatal(err)
		}
		if task := must(s.Lease([]string{"tailor"}, "test")); task == nil || task.Stage != "tailor" {
			t.Fatalf("tailor lease = %+v", task)
		}
		// Score before parse when both are ready.
		s2, _ := newStore(t)
		addJobs(t, s2, 2)
		startFetched(t, s2, 2, "v1")
		p := leaseJob(t, s2, "parse", "job-02")
		if err := s2.Done(p.ID, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
		task := must(s2.Lease([]string{"score", "parse"}, "test"))
		if task == nil || task.Stage != "score" {
			t.Fatalf("lease(score, parse) = %+v, want the score task", task)
		}
	})

	t.Run("5 done moves each job to its next stage", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 2)
		startFetched(t, s, 2, "v1")
		for _, job := range []string{"job-01", "job-02"} {
			p := leaseJob(t, s, "parse", job)
			if err := s.Done(p.ID, json.RawMessage(`{"keywords":20}`)); err != nil {
				t.Fatal(err)
			}
			if got := tasks(t, s, "job_id = ? AND stage = 'score'", job); len(got) != 1 || got[0].State != "queued" {
				t.Fatalf("%s score task = %+v", job, got)
			}
		}
		sc := leaseJob(t, s, "score", "job-02")
		if err := s.Done(sc.ID, json.RawMessage(`{"score":71,"decision":"adapt"}`)); err != nil {
			t.Fatal(err)
		}
		if got := tasks(t, s, "job_id = 'job-02' AND stage = 'tailor'"); len(got) != 1 || got[0].State != "queued" {
			t.Fatalf("tailor task = %+v", got)
		}
		sc1 := leaseJob(t, s, "score", "job-01")
		if err := s.Done(sc1.ID, json.RawMessage(`{"decision":"not_tailored"}`)); err != nil {
			t.Fatal(err)
		}
		if got := tasks(t, s, "job_id = 'job-01' AND stage = 'tailor'"); len(got) != 0 {
			t.Fatalf("not_tailored job got a tailor task: %+v", got)
		}
		if got := tasks(t, s, "job_id = 'job-01' AND stage = 'score'"); got[0].Final != 1 {
			t.Fatalf("not_tailored score task final = %d, want 1", got[0].Final)
		}
		tl := leaseJob(t, s, "tailor", "job-02")
		if err := s.Done(tl.ID, json.RawMessage(`{"decision":"adapt"}`)); err != nil {
			t.Fatal(err)
		}
		if got := tasks(t, s, "job_id = 'job-02' AND stage = 'tailor'"); got[0].Final != 1 {
			t.Fatalf("tailor final = %d, want 1", got[0].Final)
		}
	})

	t.Run("6 fail retries with backoff, then fails", func(t *testing.T) {
		s, c := newStore(t)
		addJobs(t, s, 2)
		startFetched(t, s, 2, "v1")
		p := leaseJob(t, s, "parse", "job-02")
		for attempt, wait := range []time.Duration{30 * time.Second, 60 * time.Second} {
			if err := s.Fail(p.ID, "timeout", "no answer"); err != nil {
				t.Fatal(err)
			}
			r := tasks(t, s, "id = ?", p.ID)[0]
			if r.State != "queued" || r.RetryAt.String != c.t.Add(wait).Format(time.RFC3339) {
				t.Fatalf("attempt %d: %+v, want queued retry at +%s", attempt+1, r, wait)
			}
			// Not leasable before retry_at (job-01's parse task is the only other ready one).
			if task := must(s.Lease([]string{"parse"}, "test")); task != nil && task.ID == p.ID {
				t.Fatalf("leased before retry_at")
			} else if task != nil {
				s.db.Exec(`UPDATE queue_tasks SET state = 'queued', attempts = 0 WHERE id = ?`, task.ID)
			}
			c.t = c.t.Add(wait + time.Second)
			p = leaseJob(t, s, "parse", "job-02")
		}
		if err := s.Fail(p.ID, "timeout", "no answer"); err != nil {
			t.Fatal(err)
		}
		if r := tasks(t, s, "id = ?", p.ID)[0]; r.State != "failed" || r.Attempts != 3 {
			t.Fatalf("after 3 attempts: %+v, want failed", r)
		}
		q := leaseJob(t, s, "parse", "job-01")
		if err := s.Fail(q.ID, "invalid_output", "must_have"); err != nil {
			t.Fatal(err)
		}
		if r := tasks(t, s, "id = ?", q.ID)[0]; r.State != "failed" || r.Code != "invalid_output" {
			t.Fatalf("invalid_output: %+v, want failed at once", r)
		}
		if err := s.Done(q.ID, nil); !errors.Is(err, ErrNotLeased) {
			t.Fatalf("Done on a failed task: %v, want ErrNotLeased", err)
		}
		if err := s.Fail(q.ID, "timeout", ""); !errors.Is(err, ErrNotLeased) {
			t.Fatalf("Fail on a failed task: %v, want ErrNotLeased", err)
		}
	})

	t.Run("7 expired leases go back to the queue, then fail", func(t *testing.T) {
		s, c := newStore(t)
		addJobs(t, s, 1)
		startFetched(t, s, 1, "v1")
		for attempt := 1; attempt <= 3; attempt++ {
			p := must(s.Lease([]string{"parse"}, "test"))
			if p == nil || p.Attempts != attempt {
				t.Fatalf("attempt %d lease = %+v", attempt, p)
			}
			c.t = c.t.Add(11 * time.Minute) // parse lease is 10 minutes
			if n := must(s.ExpireLeases()); n != 1 {
				t.Fatalf("attempt %d expired %d, want 1", attempt, n)
			}
		}
		r := tasks(t, s, "stage = 'parse'")[0]
		if r.State != "failed" || r.Code != "lease_expired" {
			t.Fatalf("after 3 expiries: %+v, want failed lease_expired", r)
		}
	})

	t.Run("8 batch status and retry", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 3)
		id := startFetched(t, s, 3, "v1")
		p := leaseJob(t, s, "parse", "job-03")
		if err := s.Fail(p.ID, "invalid_output", "x"); err != nil {
			t.Fatal(err)
		}
		b := must(s.Batch(id))
		if b.Stages["fetch"].Done != 1 || b.Stages["parse"].Queued != 2 || b.Stages["parse"].Failed != 1 || !b.Running {
			t.Fatalf("status = %+v", b)
		}
		if len(b.Failed) != 1 || b.Failed[0].ErrorCode != "invalid_output" || b.Failed[0].JobID != "job-03" {
			t.Fatalf("failed list = %+v", b.Failed)
		}
		if n := must(s.RetryBatch(id)); n != 1 {
			t.Fatalf("RetryBatch = %d, want 1", n)
		}
		if b := must(s.Batch(id)); b.Stages["parse"].Queued != 3 || b.Stages["parse"].Failed != 0 {
			t.Fatalf("after retry = %+v", b.Stages)
		}
		if _, err := s.Batch(999); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("Batch(999) err = %v, want sql.ErrNoRows", err)
		}
	})
}
