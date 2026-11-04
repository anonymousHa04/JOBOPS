package store

import "fmt"

// Sweep scores leftovers: every parsed job that no batch has scored (parsed by hand with
// jd parse or job add, or before the queue existed). It queues a score task for up to max
// such jobs, newest first, under a new batch (parse_version "sweep") so batch status shows
// them; the score result then decides tailoring as in any batch. Skipped: jobs the last
// preference check rejected, and jobs with an open or finished score or tailor task, or an
// open parse task (a running batch will score those itself). Returns batch 0 when there is
// nothing to do.
func (s *Store) Sweep(max int) (int64, int, error) {
	if max <= 0 || max > MaxLimit {
		max = MaxLimit
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, fmt.Errorf("sweep: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT r.job_id FROM job_requirements r JOIN jobs j ON j.id = r.job_id
		WHERE r.job_id NOT IN (SELECT job_id FROM job_filter WHERE ok = 0)
		  AND r.job_id NOT IN (SELECT job_id FROM queue_tasks WHERE stage IN ('score', 'tailor')
		                       OR (stage = 'parse' AND state IN ('queued', 'leased')))
		GROUP BY r.job_id ORDER BY MAX(j.first_seen_at) DESC LIMIT ?`, max)
	if err != nil {
		return 0, 0, fmt.Errorf("sweep: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("sweep: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("sweep: %w", err)
	}
	if len(ids) == 0 {
		return 0, 0, nil
	}

	now := s.ts(0)
	res, err := tx.Exec(`INSERT INTO queue_batches (limit_n, parse_version, created_at) VALUES (?, 'sweep', ?)`, len(ids), now)
	if err != nil {
		return 0, 0, fmt.Errorf("sweep: %w", err)
	}
	batchID, err := res.LastInsertId()
	if err != nil {
		return 0, 0, fmt.Errorf("sweep: %w", err)
	}
	for _, id := range ids {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO queue_tasks (batch_id, job_id, stage, state, created_at, updated_at)
			VALUES (?, ?, 'score', 'queued', ?, ?)`, batchID, id, now, now); err != nil {
			return 0, 0, fmt.Errorf("sweep: %w", err)
		}
	}
	return batchID, len(ids), tx.Commit()
}
