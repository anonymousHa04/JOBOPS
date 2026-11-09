package store

import (
	"database/sql"
	"errors"
	"fmt"

	"jobops/queue/internal/events"
)

// ErrNotParsed: Rescore was asked for a job that has no parsed requirements.
var ErrNotParsed = errors.New("job not parsed")

// Rescore queues one score task for a job whose bank evidence changed (the UI's Gaps tab added
// a bullet or a skill). It goes under a new batch (parse_version "rescore"). A rescore only
// updates the score: Done does not queue tailor for it; the user asks for that (Tailor).
// Nothing is queued (batch 0) while the job already has an open score or tailor task: that
// task reads the new bank anyway.
// RescoreVersion is the prompt_version of a rescore batch's tasks.
func RescoreVersion(batchID int64) string { return fmt.Sprintf("rescore-%d", batchID) }

// TailorVersion is the prompt_version of a tailor task the user asked for.
func TailorVersion(batchID int64) string { return fmt.Sprintf("retailor-%d", batchID) }

func (s *Store) Rescore(jobID string) (int64, error) {
	id, n, err := s.RescoreJobs([]string{jobID})
	if err != nil || n == 0 {
		return 0, err
	}
	return id, nil
}

// RescoreJobs queues a score task for each job, all under one new batch (Rescore all). Jobs
// with an open score or tailor task are skipped. With one job, a job that is not parsed is
// ErrNotParsed; with more, it is skipped. Returns the batch id (0 when nothing was queued)
// and how many tasks were queued.
func (s *Store) RescoreJobs(jobIDs []string) (int64, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, fmt.Errorf("rescore: %w", err)
	}
	defer tx.Rollback()

	var todo []string
	for _, jobID := range jobIDs {
		ok, err := ready(tx, jobID)
		if errors.Is(err, ErrNotParsed) && len(jobIDs) > 1 {
			continue
		}
		if err != nil {
			return 0, 0, err
		}
		if ok {
			todo = append(todo, jobID)
		}
	}
	if len(todo) == 0 {
		return 0, 0, nil
	}
	now := s.ts(0)
	batchID, err := newBatch(tx, len(todo), "rescore", now)
	if err != nil {
		return 0, 0, err
	}
	// Its own prompt_version (rescore-<batch>): a job has one task per stage and version, and the
	// job's earlier score (and maybe tailor) task holds the default one.
	evs := make([]events.Event, 0, len(todo))
	for _, jobID := range todo {
		if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
			VALUES (?, ?, 'score', ?, 'queued', ?, ?)`, batchID, jobID, RescoreVersion(batchID), now, now); err != nil {
			return 0, 0, fmt.Errorf("rescore: %w", err)
		}
		evs = append(evs, events.Event{Kind: "task", JobID: jobID, BatchID: batchID, Stage: "score", State: "queued"})
	}
	return batchID, len(todo), s.commit(tx, evs...)
}

// Tailor queues one tailor task for a job (the UI's Tailor now), under a new batch
// (parse_version "tailor"). Batch 0 while the job has an open score or tailor task.
func (s *Store) Tailor(jobID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("tailor: %w", err)
	}
	defer tx.Rollback()
	ok, err := ready(tx, jobID)
	if err != nil || !ok {
		return 0, err
	}
	now := s.ts(0)
	batchID, err := newBatch(tx, 1, "tailor", now)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
		VALUES (?, ?, 'tailor', ?, 'queued', ?, ?)`, batchID, jobID, TailorVersion(batchID), now, now); err != nil {
		return 0, fmt.Errorf("tailor: %w", err)
	}
	return batchID, s.commit(tx, events.Event{Kind: "task", JobID: jobID, BatchID: batchID, Stage: "tailor", State: "queued"})
}

// ready: the job is parsed (else ErrNotParsed) and has no open score or tailor task.
func ready(tx *sql.Tx, jobID string) (bool, error) {
	var one int
	if err := tx.QueryRow(`SELECT 1 FROM job_requirements WHERE job_id = ? LIMIT 1`, jobID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNotParsed
		}
		return false, fmt.Errorf("queue: %w", err)
	}
	var open int
	if err := tx.QueryRow(`SELECT count(*) FROM queue_tasks WHERE job_id = ? AND stage IN ('score', 'tailor')
		AND state IN ('queued', 'leased')`, jobID).Scan(&open); err != nil {
		return false, fmt.Errorf("queue: %w", err)
	}
	return open == 0, nil
}

func newBatch(tx *sql.Tx, n int, kind, now string) (int64, error) {
	res, err := tx.Exec(`INSERT INTO queue_batches (limit_n, parse_version, created_at) VALUES (?, ?, ?)`, n, kind, now)
	if err != nil {
		return 0, fmt.Errorf("queue: %w", err)
	}
	return res.LastInsertId()
}
