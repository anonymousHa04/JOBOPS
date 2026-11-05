package store

import "fmt"

// Forget removes a job's queue tasks and its preference-check row, after the user deleted the
// job (the API removes the jobs row and the rest). Returns how many tasks were removed. A task
// a worker holds right now is removed too: the API refuses the delete while one is leased, so
// this only meets one in a race, and that worker's done or fail then finds no task.
func (s *Store) Forget(jobID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("forget: %w", err)
	}
	defer tx.Rollback()
	res, err := tx.Exec(`DELETE FROM queue_tasks WHERE job_id = ?`, jobID)
	if err != nil {
		return 0, fmt.Errorf("forget: %w", err)
	}
	n, _ := res.RowsAffected()
	if _, err := tx.Exec(`DELETE FROM job_filter WHERE job_id = ?`, jobID); err != nil {
		return 0, fmt.Errorf("forget: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM kept_jobs WHERE job_id = ?`, jobID); err != nil {
		return 0, fmt.Errorf("forget: %w", err)
	}
	return int(n), tx.Commit()
}
