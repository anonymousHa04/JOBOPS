package store

import (
	"database/sql"
	"fmt"
)

type StageCount struct {
	Queued int `json:"queued"`
	Leased int `json:"leased"`
	Done   int `json:"done"`
	Failed int `json:"failed"`
}

type BatchStatus struct {
	ID        int64                 `json:"id"`
	Limit     int                   `json:"limit"`
	CreatedAt string                `json:"created_at"`
	Running   bool                  `json:"running"`
	Stages    map[string]StageCount `json:"stages"`
	Failed    []Task                `json:"failed,omitempty"`
	Tailored  int                   `json:"tailored"`
}

// Batch: per-stage counts, the failed tasks (without results), and tailored resumes.
func (s *Store) Batch(id int64) (*BatchStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bs, err := s.counts(id)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT `+taskCols+` FROM queue_tasks WHERE batch_id = ? AND state = 'failed' ORDER BY id`, id)
	if err != nil {
		return nil, fmt.Errorf("batch: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("batch: %w", err)
		}
		t.Result = nil
		bs.Failed = append(bs.Failed, *t)
	}
	return bs, rows.Err()
}

// Batches: the latest n batches, newest first, without their failed lists.
func (s *Store) Batches(n int) ([]BatchStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id FROM queue_batches ORDER BY id DESC LIMIT ?`, n)
	if err != nil {
		return nil, fmt.Errorf("batches: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("batches: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	out := []BatchStatus{}
	for _, id := range ids {
		bs, err := s.counts(id)
		if err != nil {
			return nil, err
		}
		out = append(out, *bs)
	}
	return out, nil
}

// counts reads one batch and its per-stage counts; sql.ErrNoRows when it does not exist.
func (s *Store) counts(id int64) (*BatchStatus, error) {
	bs := BatchStatus{Stages: map[string]StageCount{}}
	err := s.db.QueryRow(`SELECT id, limit_n, created_at FROM queue_batches WHERE id = ?`, id).Scan(&bs.ID, &bs.Limit, &bs.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("batch: %w", err)
	}
	rows, err := s.db.Query(`SELECT stage, state, COUNT(*) FROM queue_tasks WHERE batch_id = ? GROUP BY stage, state`, id)
	if err != nil {
		return nil, fmt.Errorf("batch: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var stage, state string
		var n int
		if err := rows.Scan(&stage, &state, &n); err != nil {
			return nil, fmt.Errorf("batch: %w", err)
		}
		c := bs.Stages[stage]
		switch state {
		case "queued":
			c.Queued += n
			bs.Running = true
		case "leased":
			c.Leased += n
			bs.Running = true
		case "done":
			c.Done += n
			if stage == "tailor" {
				bs.Tailored += n
			}
		case "failed":
			c.Failed += n
		}
		bs.Stages[stage] = c
	}
	return &bs, rows.Err()
}
