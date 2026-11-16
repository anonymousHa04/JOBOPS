package store

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestOpenAddsUnskipOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.db")
	first, err := Open(path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatalf("second open (unskip column already there): %v", err)
	}
	t.Cleanup(func() { s.Close() })

	id := must(s.StartBatchWith(3, "v1", []string{"java"}))
	if got := must(s.Batch(id)).Unskip; !slices.Equal(got, []string{"java"}) {
		t.Errorf("Unskip = %v, want [java]", got)
	}
	plain := must(s.StartBatch(3, "v1"))
	if got := must(s.Batch(plain)).Unskip; len(got) != 0 {
		t.Errorf("Unskip of a plain batch = %v, want empty", got)
	}
}

func TestBatchOnlyVerdicts(t *testing.T) {
	s := filterStore(t)
	must(s.SaveVerdicts([]Verdict{{ID: "job-03", OK: false, Reason: "keyword: java"}}))
	idA := must(s.StartBatchWith(10, "v2", []string{"java"}))
	must(s.SaveBatchVerdicts(idA, []Verdict{{ID: "job-03", OK: true}}))
	idB := must(s.StartBatch(10, "v2"))

	// queued runs queueJobs for one batch in a transaction that is rolled back.
	queued := func(batchID int64) []string {
		t.Helper()
		tx, err := s.db.Begin()
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback()
		ids, err := s.queueJobs(tx, batchID)
		if err != nil {
			t.Fatalf("queueJobs(%d): %v", batchID, err)
		}
		return ids
	}

	if ids := queued(idA); !slices.Contains(ids, "job-03") {
		t.Errorf("batch A (unskip java) queued %v, want job-03 in it", ids)
	}
	if ids := queued(idB); slices.Contains(ids, "job-03") {
		t.Errorf("batch B (no unskip) queued %v, want no job-03", ids)
	}

	var ok int
	if err := s.db.QueryRow(`SELECT ok FROM job_filter WHERE job_id = 'job-03'`).Scan(&ok); err != nil {
		t.Fatalf("read job_filter: %v", err)
	}
	if ok != 0 {
		t.Errorf("job_filter ok for job-03 = %d, want 0 (batch verdicts must not touch it)", ok)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM batch_filter WHERE batch_id = ?`, idB).Scan(&n); err != nil {
		t.Fatalf("count batch_filter: %v", err)
	}
	if n != 0 {
		t.Errorf("batch_filter rows for batch B = %d, want 0", n)
	}
}

func TestCompanyRows(t *testing.T) {
	s, _ := newStore(t)
	id := must(s.StartBatch(3, "v1"))

	err := s.SaveCompanies(id, []Company{
		{Name: "Zeta", Status: "fetched", Postings: 5, Matched: 1, Titles: []string{"SSE"}},
		{Name: "Beta", Status: "unreachable", Error: "board down"},
		{Name: "Alpha", Status: "no_slug"},
	})
	if err != nil {
		t.Fatalf("SaveCompanies: %v", err)
	}

	rows := must(s.Batch(id)).Companies
	var names []string
	for _, c := range rows {
		names = append(names, c.Name)
		if c.Titles == nil {
			t.Errorf("%s: Titles is nil, want a non-nil slice", c.Name)
		}
		if c.Name == "Zeta" && !slices.Equal(c.Titles, []string{"SSE"}) {
			t.Errorf("Zeta Titles = %v, want [SSE]", c.Titles)
		}
	}
	if want := []string{"Beta", "Alpha", "Zeta"}; !slices.Equal(names, want) {
		t.Fatalf("company order = %v, want %v", names, want)
	}

	if err := s.UpsertCompany(id, Company{Name: "Beta", Board: "ashby", Slug: "beta", Status: "fetched", Postings: 2}); err != nil {
		t.Fatalf("UpsertCompany: %v", err)
	}
	rows = must(s.Batch(id)).Companies
	if len(rows) != 3 {
		t.Fatalf("after upsert: %d rows, want 3: %+v", len(rows), rows)
	}
	var beta *Company
	for i := range rows {
		if rows[i].Name == "Beta" {
			beta = &rows[i]
		}
	}
	if beta == nil {
		t.Fatalf("after upsert: no Beta row in %+v", rows)
	}
	if beta.Status != "fetched" {
		t.Errorf("Beta status = %q, want fetched", beta.Status)
	}
	if beta.RetriedAt == "" {
		t.Error("Beta RetriedAt is empty, want the retry time")
	}

	if err := s.SaveCompanies(id, []Company{{Name: "Alpha", Status: "no_slug"}}); err != nil {
		t.Fatalf("SaveCompanies (only Alpha): %v", err)
	}
	if rows := must(s.Batch(id)).Companies; len(rows) != 1 {
		t.Errorf("after replacing with Alpha only: %d rows, want 1: %+v", len(rows), rows)
	}
}
