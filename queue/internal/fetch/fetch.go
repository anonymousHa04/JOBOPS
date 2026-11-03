// Package fetch runs the job search (jd-search, which posts matching jobs to the JobOps API)
// for a batch's fetch task.
package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Runner func(ctx context.Context) (Summary, error)

type Summary struct {
	Matched    int `json:"matched"`
	Created    int `json:"created"`
	Duplicates int `json:"duplicates"`
}

func JDSearch(repoRoot string) Runner {
	return func(ctx context.Context) (Summary, error) {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		var stdout, stderr bytes.Buffer
		cmd := exec.CommandContext(ctx, "go", "run", "./cmd/jd-search", "run")
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
