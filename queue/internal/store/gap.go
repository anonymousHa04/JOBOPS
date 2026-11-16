package store

import (
	"fmt"

	"jobops/queue/internal/events"
)

// GapVersion is the prompt_version of a gap help task: the gap's key (the API's gapKey of the
// requirement) and the batch, so a gap explained before can be asked again (Refresh).
func GapVersion(key string, batchID int64) string { return fmt.Sprintf("gap-%s-%d", key, batchID) }

// GapHelp queues one gap_help task per key for a job (the Gaps tab's Explain and Explain all),
// all under one new batch (parse_version "gap"). A key whose task is still queued or leased is
// skipped. The Mac worker runs them one at a time (groupLimit), so none waits in llama-server.
// Returns the batch id (0 when nothing was queued) and how many tasks were queued.
func (s *Store) GapHelp(jobID string, keys []string) (int64, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, fmt.Errorf("gap help: %w", err)
	}
	defer tx.Rollback()
	var todo []string
	seen := map[string]bool{}
	for _, k := range keys {
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		var open int
		if err := tx.QueryRow(`SELECT count(*) FROM queue_tasks WHERE job_id = ? AND stage = 'gap_help'
			AND state IN ('queued', 'leased') AND prompt_version LIKE ?`, jobID, "gap-"+k+"-%").Scan(&open); err != nil {
			return 0, 0, fmt.Errorf("gap help: %w", err)
		}
		if open == 0 {
			todo = append(todo, k)
		}
	}
	if len(todo) == 0 {
		return 0, 0, nil
	}
	now := s.ts(0)
	batchID, err := newBatch(tx, len(todo), "gap", now)
	if err != nil {
		return 0, 0, err
	}
	evs := make([]events.Event, 0, len(todo))
	for _, k := range todo {
		if _, err := tx.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
			VALUES (?, ?, 'gap_help', ?, 'queued', ?, ?)`, batchID, jobID, GapVersion(k, batchID), now, now); err != nil {
			return 0, 0, fmt.Errorf("gap help: %w", err)
		}
		evs = append(evs, events.Event{Kind: "task", JobID: jobID, BatchID: batchID, Stage: "gap_help", State: "queued"})
	}
	return batchID, len(todo), s.commit(tx, evs...)
}
