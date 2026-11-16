package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"jobops/queue/internal/events"
)

// Company is one preferred company's result in a batch's search (jd-search writes it).
// Status is one of fetched, unreachable, no_slug, excluded; Error is set only when unreachable.
type Company struct {
	Name       string   `json:"name"`
	Board      string   `json:"board"`
	Slug       string   `json:"slug"`
	Status     string   `json:"status"`
	Error      string   `json:"error"`
	Postings   int      `json:"postings"`
	Matched    int      `json:"matched"`
	Created    int      `json:"created"`
	Duplicates int      `json:"duplicates"`
	Titles     []string `json:"titles"`
	RetriedAt  string   `json:"retried_at,omitempty"`
}

const companyInsert = `INSERT OR REPLACE INTO batch_companies
	(batch_id, name, board, slug, status, error, postings, matched, created, duplicates, titles, retried_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

// titlesJSON encodes a company's titles; nil is stored as [].
func titlesJSON(titles []string) (string, error) {
	if titles == nil {
		titles = []string{}
	}
	b, err := json.Marshal(titles)
	return string(b), err
}

// nullable maps "" to NULL.
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// SaveCompanies replaces a batch's company rows with rows, in one transaction.
func (s *Store) SaveCompanies(batchID int64, rows []Company) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("save companies: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM batch_companies WHERE batch_id = ?`, batchID); err != nil {
		return fmt.Errorf("save companies: %w", err)
	}
	for _, c := range rows {
		titles, err := titlesJSON(c.Titles)
		if err != nil {
			return fmt.Errorf("save companies: %w", err)
		}
		if _, err := tx.Exec(companyInsert, batchID, c.Name, c.Board, c.Slug, c.Status, c.Error,
			c.Postings, c.Matched, c.Created, c.Duplicates, titles, nullable(c.RetriedAt)); err != nil {
			return fmt.Errorf("save companies: %w", err)
		}
	}
	return s.commit(tx)
}

// UpsertCompany inserts or replaces one company row of a batch (a retry) and stamps retried_at.
func (s *Store) UpsertCompany(batchID int64, c Company) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	titles, err := titlesJSON(c.Titles)
	if err != nil {
		return fmt.Errorf("upsert company: %w", err)
	}
	if _, err := s.db.Exec(companyInsert, batchID, c.Name, c.Board, c.Slug, c.Status, c.Error,
		c.Postings, c.Matched, c.Created, c.Duplicates, titles, s.ts(0)); err != nil {
		return fmt.Errorf("upsert company: %w", err)
	}
	return nil
}

// companiesOf lists a batch's company rows: problems first (unreachable, no_slug, excluded),
// then fetched, each by name. The caller holds s.mu.
func (s *Store) companiesOf(batchID int64) ([]Company, error) {
	rows, err := s.db.Query(`SELECT name, board, slug, status, error, postings, matched, created,
		duplicates, titles, COALESCE(retried_at, '') FROM batch_companies WHERE batch_id = ?
		ORDER BY CASE status WHEN 'unreachable' THEN 0 WHEN 'no_slug' THEN 1 WHEN 'excluded' THEN 2
		WHEN 'fetched' THEN 3 ELSE 4 END, name`, batchID)
	if err != nil {
		return nil, fmt.Errorf("companies of: %w", err)
	}
	defer rows.Close()
	out := []Company{}
	for rows.Next() {
		var c Company
		var titles string
		if err := rows.Scan(&c.Name, &c.Board, &c.Slug, &c.Status, &c.Error, &c.Postings, &c.Matched,
			&c.Created, &c.Duplicates, &titles, &c.RetriedAt); err != nil {
			return nil, fmt.Errorf("companies of: %w", err)
		}
		if err := json.Unmarshal([]byte(titles), &c.Titles); err != nil {
			return nil, fmt.Errorf("companies of: %w", err)
		}
		if c.Titles == nil {
			c.Titles = []string{}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BatchUnskip returns the skip words a batch turned off.
func (s *Store) BatchUnskip(batchID int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unskipOf(batchID)
}

// unskipOf decodes queue_batches.unskip (empty slice when none). The caller holds s.mu.
func (s *Store) unskipOf(batchID int64) ([]string, error) {
	var raw sql.NullString
	err := s.db.QueryRow(`SELECT unskip FROM queue_batches WHERE id = ?`, batchID).Scan(&raw)
	if err == sql.ErrNoRows || (err == nil && (!raw.Valid || raw.String == "")) {
		return []string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("unskip of: %w", err)
	}
	out := []string{}
	if err := json.Unmarshal([]byte(raw.String), &out); err != nil {
		return nil, fmt.Errorf("unskip of: %w", err)
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// SaveBatchVerdicts is SaveVerdicts for one batch that turned skip words off: the results go
// to batch_filter (the batch's old rows are replaced), never to job_filter. It returns how many
// jobs were skipped, by reason.
func (s *Store) SaveBatchVerdicts(batchID int64, verdicts []Verdict) (map[string]int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("save batch verdicts: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM batch_filter WHERE batch_id = ?`, batchID); err != nil {
		return nil, fmt.Errorf("save batch verdicts: %w", err)
	}
	skipped := map[string]int{}
	for _, v := range verdicts {
		ok := 0
		if v.OK {
			ok = 1
		} else {
			skipped[v.Reason]++
		}
		if _, err := tx.Exec(`INSERT OR REPLACE INTO batch_filter (batch_id, job_id, ok, reason) VALUES (?, ?, ?, ?)`,
			batchID, v.ID, ok, v.Reason); err != nil {
			return nil, fmt.Errorf("save batch verdicts: %w", err)
		}
	}
	return skipped, s.commit(tx, events.Event{Kind: "filter", BatchID: batchID})
}

// QueueMore queues a batch's next jobs (up to its limit) and returns their ids.
func (s *Store) QueueMore(batchID int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("queue more: %w", err)
	}
	defer tx.Rollback()
	ids, err := s.queueJobs(tx, batchID)
	if err != nil {
		return nil, fmt.Errorf("queue more: %w", err)
	}
	if err := s.commit(tx, jobsQueued(batchID, ids)...); err != nil {
		return nil, fmt.Errorf("queue more: %w", err)
	}
	return ids, nil
}
