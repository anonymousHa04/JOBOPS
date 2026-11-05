package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// ErrNotParsed: Rescore was asked for a job that has no parsed requirements.
var ErrNotParsed = errors.New("job not parsed")

// Rescore queues one score task for a job whose bank evidence changed (the UI's Gaps tab added
// a bullet or a skill). It goes under a new batch (parse_version "rescore"); when the score
// decides reuse or adapt, Done queues tailor as in any batch. Nothing is queued (batch 0) while
// the job already has an open score or tailor task: that task reads the new bank anyway.
func (s *Store) Rescore(jobID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("rescore: %w", err)
	}
	defer tx.Rollback()

	var one int
	if err := tx.QueryRow(`SELECT 1 FROM job_requirements WHERE job_id = ? LIMIT 1`, jobID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotParsed
		}
		return 0, fmt.Errorf("rescore: %w", err)
	}
	var open int
	if err := tx.QueryRow(`SELECT count(*) FROM queue_tasks WHERE job_id = ? AND stage IN ('score', 'tailor')
		AND state IN ('queued', 'leased')`, jobID).Scan(&open); err != nil {
		return 0, fmt.Errorf("rescore: %w", err)
	}
	if open > 0 {
		return 0, nil
	}

	now := s.ts(0)
	res, err := tx.Exec(`INSERT INTO queue_batches (limit_n, parse_version, created_at) VALUES (1, 'rescore', ?)`, now)
	if err != nil {
		return 0, fmt.Errorf("rescore: %w", err)
	}
	batchID, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("rescore: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, state, created_at, updated_at)
		VALUES (?, ?, 'score', 'queued', ?, ?)`, batchID, jobID, now, now); err != nil {
		return 0, fmt.Errorf("rescore: %w", err)
	}
	return batchID, tx.Commit()
}
