// Package run searches every preferred company's board concurrently and sends
// matching postings to the JobOps API (POST /jobs).
package run

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"jobops/jd-search/internal/filter"
	"jobops/jd-search/internal/sources"
)

type Options struct {
	Workers    int           // concurrent companies (default 6)
	PerHostRPS float64       // requests per second per board host (default 2)
	Timeout    time.Duration // per request (default 15s)
	Retries    int           // retries on 5xx / network errors (default 2)
	APIBase    string        // JobOps API (default http://localhost:3000)
	DryRun     bool          // match only; do not POST
}

type CompanyResult struct {
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
}

type Report struct {
	Companies   int               `json:"companies"`
	Reached     int               `json:"reached"`
	Postings    int               `json:"postings"`
	Matched     int               `json:"matched"`
	Created     int               `json:"created"`
	Duplicates  int               `json:"duplicates"`
	Detected    map[string]string `json:"detected"`
	Unreachable []string          `json:"unreachable"`
	Rejected    map[string]int    `json:"rejected"`
	Samples     []string          `json:"samples"`
	// Kept, but the posting names no location; listed so the user can check them.
	LocationUnknown []string        `json:"location_unknown"`
	PayUnlisted     int             `json:"pay_unlisted"`
	Errors          []string        `json:"errors"`
	CompaniesDetail []CompanyResult `json:"companies_detail"`
}

const maxListed = 20

func (o *Options) defaults() {
	if o.Workers <= 0 {
		o.Workers = 6
	}
	if o.PerHostRPS <= 0 {
		o.PerHostRPS = 2
	}
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	if o.Retries < 0 {
		o.Retries = 0
	}
	if o.APIBase == "" {
		o.APIBase = "http://localhost:3000"
	}
}

func Search(ctx context.Context, prefs filter.Prefs, opts Options) Report {
	opts.defaults()
	rep := Report{
		Detected:        map[string]string{},
		Rejected:        map[string]int{},
		Unreachable:     []string{},
		Samples:         []string{},
		Errors:          []string{},
		LocationUnknown: []string{},
		CompaniesDetail: []CompanyResult{},
	}
	var mu sync.Mutex
	companyResults := make(map[string]*CompanyResult)

	boards := &http.Client{Timeout: opts.Timeout, Transport: &limited{
		base: http.DefaultTransport, every: time.Duration(float64(time.Second) / opts.PerHostRPS),
		retries: opts.Retries, next: map[string]time.Time{},
	}}
	api := &http.Client{Timeout: opts.Timeout}

	excluded := map[string]bool{}
	for _, name := range prefs.Companies.Exclude {
		excluded[strings.ToLower(name)] = true
	}
	queue := make(chan filter.Company)
	var wg sync.WaitGroup
	for range opts.Workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range queue {
				ats, posts, err := fetch(ctx, boards, c)
				mu.Lock()
				if err != nil || ats == "" {
					rep.Unreachable = append(rep.Unreachable, c.Name)
					msg := "no board found"
					if err != nil {
						msg = err.Error()
					}
					companyResults[c.Name] = &CompanyResult{Name: c.Name, Slug: c.Slug, Status: "unreachable", Error: msg, Titles: []string{}}
					if err != nil && len(rep.Errors) < maxListed {
						rep.Errors = append(rep.Errors, c.Name+": "+err.Error())
					}
					mu.Unlock()
					continue
				}
				rep.Reached++
				rep.Detected[c.Name] = ats
				rep.Postings += len(posts)
				row := &CompanyResult{Name: c.Name, Board: ats, Slug: c.Slug, Status: "fetched", Postings: len(posts), Titles: []string{}}
				companyResults[c.Name] = row
				mu.Unlock()

				for _, p := range posts {
					ok, reason := filter.Match(prefs, p)
					if ok && p.Describe != nil {
						p, ok, reason = describe(ctx, prefs, p)
					}
					mu.Lock()
					if !ok {
						rep.Rejected[reason]++
						mu.Unlock()
						continue
					}
					rep.Matched++
					row.Matched++
					if len(row.Titles) < maxListed {
						row.Titles = append(row.Titles, p.Title)
					}
					if _, found := filter.PayLPA(p.Description); !found {
						rep.PayUnlisted++
					}
					if p.Location == "" && len(rep.LocationUnknown) < maxListed {
						rep.LocationUnknown = append(rep.LocationUnknown, fmt.Sprintf("%s: %s (%s)", p.Company, p.Title, p.URL))
					}
					if len(rep.Samples) < maxListed {
						rep.Samples = append(rep.Samples, fmt.Sprintf("%s: %s (%s)", p.Company, p.Title, p.Location))
					}
					mu.Unlock()
					if opts.DryRun {
						continue
					}
					created, err := post(ctx, api, opts.APIBase, p)
					mu.Lock()
					switch {
					case err != nil:
						if len(rep.Errors) < maxListed {
							rep.Errors = append(rep.Errors, p.URL+": "+err.Error())
						}
					case created:
						rep.Created++
						row.Created++
					default:
						rep.Duplicates++
						row.Duplicates++
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, c := range prefs.Companies.Include {
		if excluded[strings.ToLower(c.Name)] || c.Slug == "" {
			status := "no_slug"
			if excluded[strings.ToLower(c.Name)] {
				status = "excluded"
			}
			mu.Lock()
			companyResults[c.Name] = &CompanyResult{Name: c.Name, Slug: c.Slug, Status: status, Titles: []string{}}
			mu.Unlock()
			continue
		}
		rep.Companies++
		select {
		case queue <- c:
		case <-ctx.Done():
		}
	}
	close(queue)
	wg.Wait()

	// Build rep.CompaniesDetail from companyResults
	for _, cr := range companyResults {
		rep.CompaniesDetail = append(rep.CompaniesDetail, *cr)
	}
	sort.Slice(rep.CompaniesDetail, func(i, j int) bool {
		return rep.CompaniesDetail[i].Name < rep.CompaniesDetail[j].Name
	})

	sort.Strings(rep.Unreachable)
	return rep
}

// describe fills a posting that passed the title filter, then checks the location again
// if the list had none.
func describe(ctx context.Context, prefs filter.Prefs, p sources.Posting) (sources.Posting, bool, string) {
	hadLocation := p.Location != ""
	d, err := p.Describe(ctx)
	p.Describe = nil
	if err != nil {
		return p, false, "describe"
	}
	p.Description = d.Description
	if p.PostedAt == "" {
		p.PostedAt = d.PostedAt
	}
	if !hadLocation && d.Location != "" {
		p.Location = d.Location
		p.Remote = p.Remote || strings.Contains(strings.ToLower(d.Location), "remote")
	}
	// Still none: one of the user's cities named in the description is the best guess.
	if p.Location == "" {
		desc := strings.ToLower(p.Description)
		for _, c := range prefs.Location.Cities {
			if c != "" && strings.Contains(desc, strings.ToLower(c)) {
				p.Location = c + " (from the description)"
				break
			}
		}
	}
	if hadLocation || p.Location != "" {
		ok, reason := filter.Match(prefs, p)
		return p, ok, reason
	}
	if k := filter.SkipKeyword(prefs, p); k != "" {
		return p, false, "keyword: " + k
	}
	if p.Description != "" && !filter.PayOK(prefs, p.Description) {
		return p, false, "compensation"
	}
	return p, true, ""
}

func fetch(ctx context.Context, c *http.Client, co filter.Company) (string, []sources.Posting, error) {
	if co.ATS == "" || co.ATS == "auto" {
		return sources.Detect(ctx, c, co.Slug, co.Name)
	}
	f, ok := sources.Fetchers[co.ATS]
	if !ok {
		return "", nil, fmt.Errorf("unknown ats %q", co.ATS)
	}
	posts, err := f(ctx, c, co.Slug, co.Name)
	return co.ATS, posts, err
}

// post sends one posting to POST /jobs, trimmed to the API's limits.
// Returns true when the job is new (201), false for a known job (200).
func post(ctx context.Context, c *http.Client, base string, p sources.Posting) (bool, error) {
	desc := p.Description
	if desc == "" {
		desc = p.Title
	}
	body := map[string]any{
		"title":       cut(p.Title, 300),
		"company":     cut(p.Company, 200),
		"description": cut(desc, 45000), // under the 50k limit in UTF-16 units too
		"source_url":  p.URL,
		"source_name": p.Source,
	}
	if p.Location != "" {
		body["location"] = cut(p.Location, 200)
	}
	if p.PostedAt != "" {
		body["posted_at"] = p.PostedAt
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/jobs", bytes.NewReader(b))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated:
		return true, nil
	case http.StatusOK:
		return false, nil
	default:
		return false, fmt.Errorf("POST /jobs: status %d", resp.StatusCode)
	}
}

func cut(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

// limited spaces requests to each host and retries 5xx and network errors with
// exponential backoff. 4xx responses are returned as is.
type limited struct {
	base    http.RoundTripper
	every   time.Duration
	retries int
	mu      sync.Mutex
	next    map[string]time.Time
}

func (l *limited) wait(ctx context.Context, host string) error {
	l.mu.Lock()
	now := time.Now()
	at := l.next[host]
	if at.Before(now) {
		at = now
	}
	l.next[host] = at.Add(l.every)
	l.mu.Unlock()
	select {
	case <-time.After(time.Until(at)):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *limited) RoundTrip(req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		if err := l.wait(req.Context(), req.URL.Host); err != nil {
			return nil, err
		}
		resp, err := l.base.RoundTrip(req)
		retry := err != nil || resp.StatusCode >= 500
		if !retry || attempt >= l.retries || req.Context().Err() != nil {
			return resp, err
		}
		if resp != nil {
			resp.Body.Close()
		}
		select {
		case <-time.After(500 * time.Millisecond << attempt):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	}
}
