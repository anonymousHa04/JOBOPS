// jd-search finds job posts that match profile/preferences.yaml.
//
//	jd-search run [--dry-run] [--workers N]   one search, prints the report
//	jd-search mcp                             MCP server on stdio
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"jobops/jd-search/internal/filter"
	"jobops/jd-search/internal/run"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: jd-search run [--dry-run] [--workers N] | jd-search mcp")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "mcp":
		err = cmdMCP()
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "jd-search:", err)
		os.Exit(1)
	}
}

// prefsPath finds preferences.yaml from the repo root or from jd-search/.
func prefsPath() string {
	if dir := os.Getenv("JOBOPS_PROFILE_DIR"); dir != "" {
		p := filepath.Join(dir, "preferences.yaml")
		// A relative dir (from .env) is relative to the repo root; jd-search runs in jd-search/.
		if _, err := os.Stat(p); err != nil && !filepath.IsAbs(dir) {
			if alt := filepath.Join("..", p); fileExists(alt) {
				return alt
			}
		}
		return p
	}
	for _, dir := range []string{"profile", "../profile"} {
		p := filepath.Join(dir, "preferences.yaml")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "profile/preferences.yaml"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func options(dryRun bool, workers int) run.Options {
	return run.Options{Workers: workers, DryRun: dryRun, Retries: 2, APIBase: os.Getenv("JOBOPS_API")}
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	dry := fs.Bool("dry-run", false, "match only; do not send jobs to the API")
	workers := fs.Int("workers", 6, "companies fetched at once")
	if err := fs.Parse(args); err != nil {
		return err
	}
	prefs, err := filter.Load(prefsPath())
	if err != nil {
		return err
	}
	rep := run.Search(context.Background(), prefs, options(*dry, *workers))
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}

type searchIn struct {
	DryRun  bool `json:"dry_run,omitempty" jsonschema:"match only; do not send jobs to the API"`
	Workers int  `json:"workers,omitempty" jsonschema:"companies fetched at once (default 6)"`
}

type boardsOut struct {
	Detected    map[string]string `json:"detected"`
	Unreachable []string          `json:"unreachable"`
}

func cmdMCP() error {
	s := mcp.NewServer(&mcp.Implementation{Name: "jd-search", Version: "0.1.0"}, nil)
	mcp.AddTool(s, &mcp.Tool{
		Name:        "search_jobs",
		Description: "Search preferred companies' job boards and send matching posts to the JobOps API. Returns a summary report.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, run.Report, error) {
		prefs, err := filter.Load(prefsPath())
		if err != nil {
			return nil, run.Report{}, err
		}
		return nil, run.Search(ctx, prefs, options(in.DryRun, in.Workers)), nil
	})
	mcp.AddTool(s, &mcp.Tool{
		Name:        "detect_boards",
		Description: "Find which job board (greenhouse, lever, ashby) each preferred company uses. Sends nothing to the API.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, boardsOut, error) {
		prefs, err := filter.Load(prefsPath())
		if err != nil {
			return nil, boardsOut{}, err
		}
		rep := run.Search(ctx, prefs, options(true, 0))
		return nil, boardsOut{Detected: rep.Detected, Unreachable: rep.Unreachable}, nil
	})
	return s.Run(context.Background(), &mcp.StdioTransport{})
}
