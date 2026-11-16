package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"jobops/queue/internal/events"

	_ "modernc.org/sqlite"
)

const (
	MaxAttempts = 3
	MaxLimit    = 100
)

var (
	ErrNotLeased = errors.New("task is not leased")
	ErrBadLimit  = errors.New("limit must be 1 to 100")
)

type Store struct {
	db  *sql.DB
	mu  sync.Mutex
	now func() time.Time
	// Events gets a change event after every commit that moves a job or batch (nil: none).
	Events *events.Hub
}

// commit commits tx, then publishes the events (only when the commit worked).
func (s *Store) commit(tx *sql.Tx, evs ...events.Event) error {
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, e := range evs {
		s.Events.Publish(e)
	}
	return nil
}

// taskEvent: a task changed state. A fetch task's job_id is "batch:<n>", not a job.
func taskEvent(t *Task, stage, state string) events.Event {
	e := events.Event{Kind: "task", BatchID: t.BatchID, Stage: stage, State: state}
	if !strings.HasPrefix(t.JobID, "batch:") {
		e.JobID = t.JobID
	}
	return e
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	if _, err := db.Exec(`
		PRAGMA journal_mode=WAL;
		PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS queue_batches (
			id INTEGER PRIMARY KEY, limit_n INTEGER NOT NULL, parse_version TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS queue_tasks (
			id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, job_id TEXT NOT NULL,
			stage TEXT NOT NULL, prompt_version TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, retry_at TEXT, worker TEXT,
			error_code TEXT, error_detail TEXT, result TEXT, final INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE (job_id, stage, prompt_version)
		);
		-- Per-company result of a batch's search.
		CREATE TABLE IF NOT EXISTS batch_companies (
			batch_id INTEGER NOT NULL, name TEXT NOT NULL, board TEXT NOT NULL DEFAULT '',
			slug TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, postings INTEGER NOT NULL DEFAULT 0,
			matched INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
			titles TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', retried_at TEXT,
			PRIMARY KEY (batch_id, name)
		);
		-- Preference verdicts of one batch that turned skip words off, never used by other batches.
		CREATE TABLE IF NOT EXISTS batch_filter (
			batch_id INTEGER NOT NULL, job_id TEXT NOT NULL, ok INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (batch_id, job_id)
		);
		CREATE INDEX IF NOT EXISTS queue_tasks_ready ON queue_tasks (stage, state, retry_at);
		-- The last preference check of each stored job (jd-search check, run by every fetch step).
		CREATE TABLE IF NOT EXISTS job_filter (
			job_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL
		);
		-- Jobs the user keeps whatever the preferences say (UI: Keep this job): the preference
		-- check leaves them out, so a skip word added later never skips them. Same DDL in api/src/db.ts.
		CREATE TABLE IF NOT EXISTS kept_jobs (job_id TEXT PRIMARY KEY, kept_at TEXT NOT NULL);
	`); err != nil {
		return nil, fmt.Errorf("failed to create tables: %w", err)
	}

	if _, err := db.Exec(`ALTER TABLE queue_batches ADD COLUMN unskip TEXT NOT NULL DEFAULT '[]'`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		return nil, fmt.Errorf("failed to add unskip: %w", err)
	}

	db.SetMaxOpenConns(1)

	return &Store{
		db:  db,
		mu:  sync.Mutex{},
		now: time.Now,
	}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) ts(d time.Duration) string {
	return s.now().Add(d).UTC().Format(time.RFC3339)
}

func groupOf(stage string) string {
	switch stage {
	case "parse", "score":
		return "laptop"
	case "tailor", "gap_help":
		return "mac"
	default:
		return ""
	}
}

// groupLimit: how many tasks of a group run at once (default 3 each). It must match the model
// server's slots: a task leased beyond them waits inside llama-server while its timeout runs.
// general7 on the laptop has LLM_GENERAL7_SLOTS (3), general14 on the Mac LLM_GENERAL14_SLOTS
// (3, llm.sh). JOBOPS_LAPTOP_SLOTS and JOBOPS_MAC_SLOTS change the queue's side.
func groupLimit(g string) int {
	def, key := 3, "JOBOPS_LAPTOP_SLOTS"
	if g == "mac" {
		key = "JOBOPS_MAC_SLOTS"
	}
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil && n > 0 {
		return n
	}
	return def
}

var leaseFor = map[string]time.Duration{
	"fetch":  30 * time.Minute,
	"parse":  10 * time.Minute,
	"score":  15 * time.Minute,
	"tailor": 30 * time.Minute,
	// gap help: one 14B answer, plus loading the model if it was asleep.
	"gap_help": 10 * time.Minute,
}

type Task struct {
	ID            int64           `json:"id"`
	BatchID       int64           `json:"batch_id"`
	JobID         string          `json:"job_id"`
	Stage         string          `json:"stage"`
	PromptVersion string          `json:"prompt_version"`
	State         string          `json:"state"`
	Attempts      int             `json:"attempts"`
	ErrorCode     string          `json:"error_code,omitempty"`
	ErrorDetail   string          `json:"error_detail,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}
