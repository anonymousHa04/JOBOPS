package store

import (
	"encoding/json"
	"testing"
)

// filterStore is a store whose jobs table has the columns the preference check reads.
func filterStore(t *testing.T) *Store {
	t.Helper()
	s, _ := newStore(t)
	for _, col := range []string{"title", "location", "description"} {
		if _, err := s.db.Exec(`ALTER TABLE jobs ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
			t.Fatal(err)
		}
	}
	addJobs(t, s, 3)
	return s
}

func TestPreferenceCheck(t *testing.T) {
	t.Run("a rejected job is never queued", func(t *testing.T) {
		s := filterStore(t)
		must(s.SaveVerdicts([]Verdict{{ID: "job-03", OK: false, Reason: "seniority"}, {ID: "job-02", OK: true}}))
		startFetched(t, s, 10, "v2")
		got := tasks(t, s, "stage = 'parse'")
		if len(got) != 2 || got[0].JobID == "job-03" || got[1].JobID == "job-03" {
			t.Fatalf("parse tasks: %+v, want job-01 and job-02 only", got)
		}
	})

	t.Run("a new verdict replaces the old one", func(t *testing.T) {
		s := filterStore(t)
		must(s.SaveVerdicts([]Verdict{{ID: "job-03", OK: false, Reason: "language"}}))
		must(s.SaveVerdicts([]Verdict{{ID: "job-03", OK: true}})) // preferences changed
		startFetched(t, s, 10, "v2")
		if got := tasks(t, s, "stage = 'parse' AND job_id = 'job-03'"); len(got) != 1 {
			t.Fatalf("job-03 not queued after its verdict became ok: %+v", got)
		}
	})

	t.Run("skipped counts by reason", func(t *testing.T) {
		s := filterStore(t)
		skipped := must(s.SaveVerdicts([]Verdict{
			{ID: "job-01", OK: false, Reason: "seniority"}, {ID: "job-02", OK: false, Reason: "seniority"},
			{ID: "job-03", OK: false, Reason: "language"},
		}))
		if skipped["seniority"] != 2 || skipped["language"] != 1 {
			t.Fatalf("skipped = %v", skipped)
		}
	})

	t.Run("candidates leave out finished and active jobs", func(t *testing.T) {
		s := filterStore(t)
		startFetched(t, s, 1, "v2") // job-03 (newest) gets a queued parse task
		ids := map[string]bool{}
		for _, j := range must(s.FilterCandidates()) {
			ids[j.ID] = true
		}
		if ids["job-03"] || !ids["job-01"] || !ids["job-02"] {
			t.Fatalf("candidates = %v, want job-01 and job-02", ids)
		}
	})

	t.Run("batch status shows the skipped counts", func(t *testing.T) {
		s := filterStore(t)
		id := must(s.StartBatch(5, "v2"))
		f := must(s.Lease([]string{"fetch"}, "test"))
		if err := s.Done(f.ID, json.RawMessage(`{"matched":3,"skipped":{"seniority":2}}`)); err != nil {
			t.Fatal(err)
		}
		bs := must(s.Batch(id))
		if bs.Skipped["seniority"] != 2 {
			t.Fatalf("batch status skipped = %v", bs.Skipped)
		}
	})
}
