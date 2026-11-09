package store

import (
	"encoding/json"
	"fmt"

	"jobops/queue/internal/events"
)

// JobText is a stored job as the preference check reads it (jd-search check).
type JobText struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Location    string `json:"location"`
	Description string `json:"description"`
}

// Verdict is one job's result from the preference check.
type Verdict struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// FilterCandidates lists the stored jobs a batch could still take: no final task, nothing
// queued or leased, and not kept by the user (a kept job is never skipped by the preferences).
// The fetch step checks them against the current preferences.
func (s *Store) FilterCandidates() ([]JobText, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id, title, COALESCE(location, ''), description FROM jobs
		WHERE id NOT IN (SELECT job_id FROM queue_tasks WHERE final = 1 OR state IN ('queued', 'leased'))
		AND id NOT IN (SELECT job_id FROM kept_jobs)
		ORDER BY first_seen_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("filter candidates: %w", err)
	}
	defer rows.Close()
	var out []JobText
	for rows.Next() {
		var j JobText
		if err := rows.Scan(&j.ID, &j.Title, &j.Location, &j.Description); err != nil {
			return nil, fmt.Errorf("filter candidates: %w", err)
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// SaveVerdicts records the check's results (one row per job, replaced each batch) and returns
// how many jobs were skipped, by reason. queueJobs never takes a job whose last verdict is not ok.
func (s *Store) SaveVerdicts(verdicts []Verdict) (map[string]int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("save verdicts: %w", err)
	}
	defer tx.Rollback()
	now := s.ts(0)
	skipped := map[string]int{}
	for _, v := range verdicts {
		ok := 0
		if v.OK {
			ok = 1
		} else {
			skipped[v.Reason]++
		}
		if _, err := tx.Exec(`INSERT INTO job_filter (job_id, ok, reason, checked_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (job_id) DO UPDATE SET ok = excluded.ok, reason = excluded.reason, checked_at = excluded.checked_at`,
			v.ID, ok, v.Reason, now); err != nil {
			return nil, fmt.Errorf("save verdicts: %w", err)
		}
	}
	return skipped, s.commit(tx, events.Event{Kind: "filter"})
}

// skippedOf reads the per-reason skip counts the fetch step stored in its task result.
func (s *Store) skippedOf(batchID int64) map[string]int {
	var raw []byte
	if err := s.db.QueryRow(`SELECT result FROM queue_tasks WHERE batch_id = ? AND stage = 'fetch' AND result IS NOT NULL`,
		batchID).Scan(&raw); err != nil {
		return nil
	}
	var r struct {
		Skipped map[string]int `json:"skipped"`
	}
	if json.Unmarshal(raw, &r) != nil || len(r.Skipped) == 0 {
		return nil
	}
	return r.Skipped
}
