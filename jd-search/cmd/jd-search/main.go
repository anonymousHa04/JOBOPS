// jd-search finds job posts that match profile/preferences.yaml.
//
//	jd-search run [--dry-run] [--workers N]   one search, prints the report
//	jd-search check                           stored jobs (JSON array on stdin) against the
//	                                          preferences; prints [{id, ok, reason}]
//	jd-search mcp                             MCP server on stdio
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"jobops/jd-search/internal/filter"
	"jobops/jd-search/internal/run"
	"jobops/jd-search/internal/sources"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: jd-search run [--dry-run] [--workers N] [--only NAME --slug S --ats A] [--unskip w1,w2] | jd-search check [--unskip w1,w2] | jd-search mcp")
		os.Exit(2)
	}
	// The careers crawler; the default runs ../api/src/careers/crawl.ts from jd-search/.
	if v := os.Getenv("JOBOPS_CRAWLER"); v != "" {
		sources.CrawlerCmd = strings.Fields(v)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "check":
		err = cmdCheck(os.Args[2:], os.Stdin, os.Stdout)
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
	only := fs.String("only", "", "search one company")
	slug := fs.String("slug", "", "board slug for --only, this run only")
	ats := fs.String("ats", "", "board type for --only, this run only")
	unskip := fs.String("unskip", "", "comma-separated skip words to ignore this run")
	if err := fs.Parse(args); err != nil {
		return err
	}
	prefs, err := filter.Load(prefsPath())
	if err != nil {
		return err
	}
	if err := applyRunFlags(&prefs, *only, *slug, *ats, *unskip); err != nil {
		return err
	}
	rep := run.Search(context.Background(), prefs, options(*dry, *workers))
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}

// applyRunFlags narrows prefs for one run (--only/--slug/--ats/--unskip).
// It changes p in memory only; the preferences file is never written.
func applyRunFlags(p *filter.Prefs, only, slug, ats, unskip string) error {
	if unskip != "" {
		drop := map[string]bool{}
		for _, w := range strings.Split(unskip, ",") {
			if w = strings.TrimSpace(w); w != "" {
				drop[strings.ToLower(w)] = true
			}
		}
		kept := p.SkipKeywords[:0:0]
		for _, w := range p.SkipKeywords {
			if !drop[strings.ToLower(strings.TrimSpace(w))] {
				kept = append(kept, w)
			}
		}
		p.SkipKeywords = kept
	}
	if only == "" {
		return nil
	}
	var picked *filter.Company
	for _, c := range p.Companies.Include {
		if strings.EqualFold(c.Name, only) {
			c := c
			picked = &c
			break
		}
	}
	if picked == nil {
		return fmt.Errorf("no company %s in preferences", only)
	}
	if slug != "" {
		picked.Slug = slug
	}
	if ats != "" {
		picked.ATS = ats
	}
	p.Companies.Include = []filter.Company{*picked}
	var exclude []string
	for _, name := range p.Companies.Exclude {
		if !strings.EqualFold(name, picked.Name) {
			exclude = append(exclude, name)
		}
	}
	p.Companies.Exclude = exclude
	return nil
}

// Verdict is one stored job's result from cmdCheck.
type Verdict struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// cmdCheck checks stored jobs against the current preferences (no network): the queue runs it
// before every batch so a job saved by an older search is skipped once the preferences exclude it.
func cmdCheck(args []string, in io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	unskip := fs.String("unskip", "", "comma-separated skip words to ignore this run")
	if err := fs.Parse(args); err != nil {
		return err
	}
	prefs, err := filter.Load(prefsPath())
	if err != nil {
		return err
	}
	if err := applyRunFlags(&prefs, "", "", "", *unskip); err != nil {
		return err
	}
	var jobs []filter.Stored
	if err := json.NewDecoder(in).Decode(&jobs); err != nil {
		return fmt.Errorf("check: read jobs: %w", err)
	}
	verdicts := make([]Verdict, 0, len(jobs))
	for _, j := range jobs {
		ok, reason := filter.CheckStored(prefs, j)
		verdicts = append(verdicts, Verdict{ID: j.ID, OK: ok, Reason: reason})
	}
	return json.NewEncoder(out).Encode(verdicts)
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
