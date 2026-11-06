package store

import (
	"errors"
	"fmt"

	"jobops/queue/internal/events"
)

// ErrBusy: the job already has an open parse, score or tailor task.
var ErrBusy = errors.New("job already has an open task")

// AddVersion is the prompt_version of the tasks of a job the user added by its link (UI).
func AddVersion(batchID int64) string { return fmt.Sprintf("add-%d", batchID) }

// Add queues a job the user pasted a link for: a parse task (a score task when it is already
// parsed), under a new batch (parse_version "add"). Done carries the add-<batch> version from
// parse to score, and that score is final: the user starts tailoring from the UI (Tailor now),
// as with a rescore. ErrBusy while the job has an open parse, score or tailor task. Returns the
// batch id and the first stage queued.
func (s *Store) Add(jobID string) (int64, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, "", fmt.Errorf("add: %w", err)
	}
	defer tx.Rollback()

	var open int
	if err := tx.QueryRow(`SELECT count(*) FROM queue_tasks WHERE job_id = ? AND stage IN ('parse', 'score', 'tailor')
		AND state IN ('queued', 'leased')`, jobID).Scan(&open); err != nil {
		return 0, "", fmt.Errorf("add: %w", err)
	}
	if open > 0 {
		return 0, "", ErrBusy
	}
	var parsed int
	if err := tx.QueryRow(`SELECT count(*) FROM job_requirements WHERE job_id = ?`, jobID).Scan(&parsed); err != nil {
		return 0, "", fmt.Errorf("add: %w", err)
	}
	stage := "parse"
	if parsed > 0 {
		stage = "score"
	}
	now := s.ts(0)
	batchID, err := newBatch(tx, 1, "add", now)
	if err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'queued', ?, ?)`, batchID, jobID, stage, AddVersion(batchID), now, now); err != nil {
		return 0, "", fmt.Errorf("add: %w", err)
	}
	return batchID, stage, s.commit(tx, events.Event{Kind: "task", JobID: jobID, BatchID: batchID, Stage: stage, State: "queued"})
}
