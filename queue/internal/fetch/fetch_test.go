package fetch

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"jobops/queue/internal/store"
)

// The real jd-search check, end to end: a stored "in Test" job saved by an older search is
// skipped by the next batch.
func TestRecheckSkipsExcludedStoredJobs(t *testing.T) {
	dir := t.TempDir()
	prefs := "roles:\n  - title: Senior Software Engineer\nseniority:\n  include: [ senior ]\n  exclude: [ test ]\n" +
		"title_filter:\n  my_languages: [ python ]\n  other_languages: [ java ]\nlocation:\n  cities: [ Bengaluru ]\n  onsite: true\n"
	if err := os.WriteFile(filepath.Join(dir, "preferences.yaml"), []byte(prefs), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JOBOPS_PROFILE_DIR", dir)

	path := filepath.Join(dir, "q.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, location TEXT,
		description TEXT NOT NULL, first_seen_at TEXT NOT NULL);
		INSERT INTO jobs VALUES
		 ('good', 'Senior Software Engineer', 'Bengaluru', '', '2026-11-01T00:01:00Z'),
		 ('test', 'Senior Software Engineer in Test', 'Bengaluru', '', '2026-11-01T00:02:00Z'),
		 ('java', 'Senior Software Engineer - Java Developer', 'Bengaluru', '', '2026-11-01T00:03:00Z')`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	skipped, err := Recheck(context.Background(), s, JDCheck(root))
	if err != nil {
		t.Fatal(err)
	}
	if skipped["seniority"] != 1 || skipped["language"] != 1 {
		t.Fatalf("skipped = %v, want seniority 1 and language 1", skipped)
	}

	id, err := s.StartBatch(10, "v2")
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.Lease([]string{"fetch"}, "test")
	if err != nil || f == nil {
		t.Fatalf("lease fetch: %v %v", f, err)
	}
	if err := s.Done(f.ID, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	bs, err := s.Batch(id)
	if err != nil {
		t.Fatal(err)
	}
	if got := bs.Stages["parse"].Queued; got != 1 {
		t.Fatalf("parse tasks queued = %d, want 1 (only the good job)", got)
	}
}
