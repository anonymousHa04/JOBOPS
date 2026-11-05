package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Lease hands out the next ready task of the first stage (in the given order) whose group is
// under its limit. Nothing ready: (nil, nil).
func (s *Store) Lease(stages []string, worker string) (*Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("lease: %w", err)
	}
	defer tx.Rollback()
	now := s.ts(0)
	for _, stage := range stages {
		if g := groupOf(stage); g != "" {
			var leased int
			if err := tx.QueryRow(`SELECT COUNT(*) FROM queue_tasks WHERE state = 'leased' AND stage IN (` + stagesOf(g) + `)`).Scan(&leased); err != nil {
				return nil, fmt.Errorf("lease: %w", err)
			}
			if leased >= groupLimit[g] {
				continue
			}
		}
		t, err := scanTask(tx.QueryRow(`SELECT `+taskCols+` FROM queue_tasks WHERE stage = ? AND state = 'queued'
			AND (retry_at IS NULL OR retry_at <= ?) ORDER BY id LIMIT 1`, stage, now))
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("lease: %w", err)
		}
		if _, err := tx.Exec(`UPDATE queue_tasks SET state = 'leased', attempts = attempts + 1, worker = ?,
			lease_until = ?, updated_at = ? WHERE id = ?`, worker, s.ts(leaseFor[stage]), now, t.ID); err != nil {
			return nil, fmt.Errorf("lease: %w", err)
		}
		t.State = "leased"
		t.Attempts++
		return t, tx.Commit()
	}
	return nil, nil
}

// Done records a finished task and queues the job's next stage (fetch: the batch's jobs).
func (s *Store) Done(taskID int64, result json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("done: %w", err)
	}
	defer tx.Rollback()
	t, err := leasedTask(tx, taskID)
	if err != nil {
		return err
	}
	now := s.ts(0)
	if len(result) == 0 {
		result = json.RawMessage("{}")
	}
	if _, err := tx.Exec(`UPDATE queue_tasks SET state = 'done', result = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
		string(result), now, taskID); err != nil {
		return fmt.Errorf("done: %w", err)
	}
	next := ""
	final := false
	switch t.Stage {
	case "fetch":
		if _, err := s.queueJobs(tx, t.BatchID); err != nil {
			return err
		}
	case "parse":
		next = "score"
	case "score":
		var r struct {
			Decision string `json:"decision"`
		}
		_ = json.Unmarshal(result, &r)
		if r.Decision == "reuse" || r.Decision == "adapt" {
			next = "tailor"
		} else {
			final = true
		}
	case "tailor":
		final = true
	}
	if next != "" {
		// A rescore's tailor keeps its version (rescore-<batch>), so a job tailored before can be
		// tailored again; every other next stage keeps the default version, as before.
		version := ""
		if strings.HasPrefix(t.PromptVersion, "rescore-") {
			version = t.PromptVersion
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'queued', ?, ?)`, t.BatchID, t.JobID, next, version, now, now); err != nil {
			return fmt.Errorf("done: %w", err)
		}
	}
	if final {
		if _, err := tx.Exec(`UPDATE queue_tasks SET final = 1 WHERE id = ?`, taskID); err != nil {
			return fmt.Errorf("done: %w", err)
		}
	}
	return tx.Commit()
}

// Fail retries a timeout or an unreachable server with backoff (30 s, 60 s) while attempts
// remain; any other code fails the task at once.
func (s *Store) Fail(taskID int64, code, detail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("fail: %w", err)
	}
	defer tx.Rollback()
	t, err := leasedTask(tx, taskID)
	if err != nil {
		return err
	}
	if len(detail) > 300 {
		detail = detail[:300]
	}
	now := s.ts(0)
	if (code == "timeout" || code == "unavailable") && t.Attempts < MaxAttempts {
		backoff := 30 * time.Second << (t.Attempts - 1)
		_, err = tx.Exec(`UPDATE queue_tasks SET state = 'queued', retry_at = ?, lease_until = NULL,
			error_code = ?, error_detail = ?, updated_at = ? WHERE id = ?`, s.ts(backoff), code, detail, now, taskID)
	} else {
		err = s.failTask(tx, t, code, detail)
	}
	if err != nil {
		return fmt.Errorf("fail: %w", err)
	}
	return tx.Commit()
}

// ExpireLeases returns tasks whose worker went away to the queue (or fails them after
// MaxAttempts).
func (s *Store) ExpireLeases() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("expire: %w", err)
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT `+taskCols+` FROM queue_tasks WHERE state = 'leased' AND lease_until < ?`, s.ts(0))
	if err != nil {
		return 0, fmt.Errorf("expire: %w", err)
	}
	var expired []*Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			rows.Close()
			return 0, fmt.Errorf("expire: %w", err)
		}
		expired = append(expired, t)
	}
	rows.Close()
	for _, t := range expired {
		if t.Attempts >= MaxAttempts {
			err = s.failTask(tx, t, "lease_expired", "the worker did not report back in time")
		} else {
			_, err = tx.Exec(`UPDATE queue_tasks SET state = 'queued', lease_until = NULL, updated_at = ? WHERE id = ?`, s.ts(0), t.ID)
		}
		if err != nil {
			return 0, fmt.Errorf("expire: %w", err)
		}
	}
	return len(expired), tx.Commit()
}

// failTask marks a task failed; a failed search still queues the jobs already stored.
func (s *Store) failTask(tx *sql.Tx, t *Task, code, detail string) error {
	if _, err := tx.Exec(`UPDATE queue_tasks SET state = 'failed', lease_until = NULL, error_code = ?,
		error_detail = ?, updated_at = ? WHERE id = ?`, code, detail, s.ts(0), t.ID); err != nil {
		return err
	}
	if t.Stage == "fetch" {
		_, err := s.queueJobs(tx, t.BatchID)
		return err
	}
	return nil
}

const taskCols = `id, batch_id, job_id, stage, prompt_version, state, attempts,
	COALESCE(error_code, ''), COALESCE(error_detail, ''), COALESCE(result, '')`

type scanner interface{ Scan(dest ...any) error }

func scanTask(r scanner) (*Task, error) {
	var t Task
	var result string
	if err := r.Scan(&t.ID, &t.BatchID, &t.JobID, &t.Stage, &t.PromptVersion, &t.State, &t.Attempts,
		&t.ErrorCode, &t.ErrorDetail, &result); err != nil {
		return nil, err
	}
	if result != "" {
		t.Result = json.RawMessage(result)
	}
	return &t, nil
}

func leasedTask(tx *sql.Tx, id int64) (*Task, error) {
	t, err := scanTask(tx.QueryRow(`SELECT `+taskCols+` FROM queue_tasks WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && t.State != "leased") {
		return nil, ErrNotLeased
	}
	return t, err
}

// stagesOf lists a group's stages for an IN (...) clause (fixed names, no user input).
func stagesOf(group string) string {
	out := ""
	for _, st := range []string{"fetch", "parse", "score", "tailor"} {
		if groupOf(st) == group {
			if out != "" {
				out += ", "
			}
			out += "'" + st + "'"
		}
	}
	return out
}
