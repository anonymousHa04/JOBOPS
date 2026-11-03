package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

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
		CREATE INDEX IF NOT EXISTS queue_tasks_ready ON queue_tasks (stage, state, retry_at);
		-- The last preference check of each stored job (jd-search check, run by every fetch step).
		CREATE TABLE IF NOT EXISTS job_filter (
			job_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL
		);
	`); err != nil {
		return nil, fmt.Errorf("failed to create tables: %w", err)
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
	case "tailor":
		return "mac"
	default:
		return ""
	}
}

var groupLimit = map[string]int{
	"laptop": 3,
	"mac":    3,
}

var leaseFor = map[string]time.Duration{
	"fetch":  30 * time.Minute,
	"parse":  10 * time.Minute,
	"score":  15 * time.Minute,
	"tailor": 30 * time.Minute,
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
