package store

import (
	"database/sql"
	"fmt"
)

// StartBatch records a batch and queues its fetch task. limit 0 means MaxLimit.
func (s *Store) StartBatch(limit int, parseVersion string) (int64, error) {
	if limit == 0 {
		limit = MaxLimit
	}
	if limit < 0 || limit > MaxLimit {
		return 0, ErrBadLimit
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("start batch: %w", err)
	}
	defer tx.Rollback()
	now := s.ts(0)
	res, err := tx.Exec(`INSERT INTO queue_batches (limit_n, parse_version, created_at) VALUES (?, ?, ?)`, limit, parseVersion, now)
	if err != nil {
		return 0, fmt.Errorf("start batch: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("start batch: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, state, created_at, updated_at)
		VALUES (?, ?, 'fetch', 'queued', ?, ?)`, id, fmt.Sprintf("batch:%d", id), now, now); err != nil {
		return 0, fmt.Errorf("start batch: %w", err)
	}
	return id, tx.Commit()
}

// queueJobs runs when a batch's fetch task ends: it takes up to the batch's limit of jobs,
// newest first, skipping finished jobs, jobs already queued in a running batch, and jobs the
// last preference check rejected (job_filter; a job never checked is taken). Failed
// tasks are queued again; a new job gets a parse task.
func (s *Store) queueJobs(tx *sql.Tx, batchID int64) (int, error) {
	var limit int
	var version string
	if err := tx.QueryRow(`SELECT limit_n, parse_version FROM queue_batches WHERE id = ?`, batchID).Scan(&limit, &version); err != nil {
		return 0, fmt.Errorf("queue jobs: %w", err)
	}
	// Read the ids first: one connection, so no statement runs while rows are open.
	rows, err := tx.Query(`SELECT id FROM jobs WHERE id NOT IN (SELECT job_id FROM job_filter WHERE ok = 0)
		ORDER BY first_seen_at DESC`)
	if err != nil {
		return 0, fmt.Errorf("queue jobs: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("queue jobs: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("queue jobs: %w", err)
	}

	now := s.ts(0)
	taken := 0
	for _, id := range ids {
		if taken >= limit {
			break
		}
		var final, active, failed, done int
		if err := tx.QueryRow(`SELECT
			COALESCE(SUM(final = 1), 0), COALESCE(SUM(state IN ('queued', 'leased')), 0),
			COALESCE(SUM(state = 'failed'), 0), COALESCE(SUM(state = 'done'), 0)
			FROM queue_tasks WHERE job_id = ?`, id).Scan(&final, &active, &failed, &done); err != nil {
			return 0, fmt.Errorf("queue jobs: %w", err)
		}
		switch {
		case final > 0 || active > 0:
			continue
		case failed > 0:
			if _, err := tx.Exec(`UPDATE queue_tasks SET state = 'queued', attempts = 0, retry_at = NULL,
				error_code = NULL, error_detail = NULL, batch_id = ?, updated_at = ? WHERE job_id = ? AND state = 'failed'`,
				batchID, now, id); err != nil {
				return 0, fmt.Errorf("queue jobs: %w", err)
			}
		case done > 0:
			// Done tasks but nothing open, failed or final: not a job this batch can move.
			continue
		default:
			if _, err := tx.Exec(`INSERT OR IGNORE INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
				VALUES (?, ?, 'parse', ?, 'queued', ?, ?)`, batchID, id, version, now, now); err != nil {
				return 0, fmt.Errorf("queue jobs: %w", err)
			}
		}
		taken++
	}
	return taken, nil
}

// RetryBatch queues every failed task of a batch again.
func (s *Store) RetryBatch(batchID int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE queue_tasks SET state = 'queued', attempts = 0, retry_at = NULL,
		error_code = NULL, error_detail = NULL, updated_at = ? WHERE batch_id = ? AND state = 'failed'`, s.ts(0), batchID)
	if err != nil {
		return 0, fmt.Errorf("retry batch: %w", err)
	}
	n, err := res.RowsAffected()
	return int(n), err
}
