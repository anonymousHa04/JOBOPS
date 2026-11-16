// Package fetch runs the job search (jd-search, which posts matching jobs to the JobOps API)
// for a batch's fetch task.
package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"jobops/queue/internal/store"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Runner func(ctx context.Context, args ...string) (Summary, error)

type Summary struct {
	Matched    int `json:"matched"`
	Created    int `json:"created"`
	Duplicates int `json:"duplicates"`
	// Stored jobs the preference check skipped (filled by the queue, not by jd-search).
	Skipped map[string]int `json:"skipped,omitempty"`
	// Every preferred company of the run (searched, unreachable, no slug, excluded).
	Companies []store.Company `json:"companies_detail,omitempty"`
}

// Checker checks stored jobs against the current preferences.
type Checker func(ctx context.Context, jobs []store.JobText, args ...string) ([]store.Verdict, error)

// JDCheck runs `jd-search check` (no network): jobs as a JSON array on stdin, verdicts on stdout.
func JDCheck(repoRoot string) Checker {
	return func(ctx context.Context, jobs []store.JobText, args ...string) ([]store.Verdict, error) {
		if jobs == nil {
			jobs = []store.JobText{}
		}
		in, err := json.Marshal(jobs)
		if err != nil {
			return nil, fmt.Errorf("jd-search check: %w", err)
		}
		ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		var stdout, stderr bytes.Buffer
		cmd := jdSearch(ctx, "check", args...)
		cmd.Dir = filepath.Join(repoRoot, "jd-search")
		cmd.Env = os.Environ()
		cmd.Stdin = bytes.NewReader(in)
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			tail := stderr.String()
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			return nil, fmt.Errorf("jd-search check: %w: %s", err, tail)
		}
		var out []store.Verdict
		if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
			return nil, fmt.Errorf("jd-search check output: %w", err)
		}
		return out, nil
	}
}

// Recheck checks every stored job a batch could take and saves the verdicts; it returns the
// skipped counts by reason.
func Recheck(ctx context.Context, s *store.Store, check Checker) (map[string]int, error) {
	jobs, err := s.FilterCandidates()
	if err != nil {
		return nil, err
	}
	verdicts, err := check(ctx, jobs)
	if err != nil {
		return nil, err
	}
	return s.SaveVerdicts(verdicts)
}

// RecheckBatch is Recheck for one batch that turned skip words off: jd-search checks with
// those words unskipped, and the verdicts are saved for that batch only (batch_filter).
func RecheckBatch(ctx context.Context, s *store.Store, check Checker, batchID int64, unskip []string) (map[string]int, error) {
	jobs, err := s.FilterCandidates()
	if err != nil {
		return nil, err
	}
	verdicts, err := check(ctx, jobs, "--unskip", strings.Join(unskip, ","))
	if err != nil {
		return nil, err
	}
	return s.SaveBatchVerdicts(batchID, verdicts)
}

// jdSearch runs jd-search with one subcommand: the prebuilt binary named by JOBOPS_JDSEARCH_BIN
// (the container image), else "go run ./cmd/jd-search" (a checkout on the Mac).
// Extra args follow the subcommand.
func jdSearch(ctx context.Context, sub string, args ...string) *exec.Cmd {
	if bin := os.Getenv("JOBOPS_JDSEARCH_BIN"); bin != "" {
		return exec.CommandContext(ctx, bin, append([]string{sub}, args...)...)
	}
	return exec.CommandContext(ctx, "go", append([]string{"run", "./cmd/jd-search", sub}, args...)...)
}

func JDSearch(repoRoot string) Runner {
	return func(ctx context.Context, args ...string) (Summary, error) {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		var stdout, stderr bytes.Buffer
		cmd := jdSearch(ctx, "run", args...)
		cmd.Dir = filepath.Join(repoRoot, "jd-search")
		cmd.Env = os.Environ()
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			tail := stderr.String()
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			return Summary{}, fmt.Errorf("jd-search: %w: %s", err, tail)
		}
		// Only the counts are read; a missing field stays 0.
		var s Summary
		if err := json.Unmarshal(stdout.Bytes(), &s); err != nil {
			return Summary{}, fmt.Errorf("jd-search report: %w", err)
		}
		return s, nil
	}
}
