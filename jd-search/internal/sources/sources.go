// Package sources fetches job postings from public job-board APIs
// (Greenhouse, Lever, Ashby). Each company is addressed by its board slug.
package sources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Posting is one job post, normalized across boards.
type Posting struct {
	Title       string
	Company     string
	Location    string
	URL         string
	Description string
	Source      string // greenhouse, lever, ashby
	PostedAt    string // UTC, 2006-01-02T15:04:05Z, or ""
	Remote      bool
}

// ErrNotFound means the board does not exist for this slug.
var ErrNotFound = errors.New("board not found")

// Fetcher returns all postings on one company's board.
type Fetcher func(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error)

// API bases; tests point these at httptest servers.
var (
	GreenhouseBase = "https://boards-api.greenhouse.io"
	LeverBase      = "https://api.lever.co"
	AshbyBase      = "https://api.ashbyhq.com"
)

// Fetchers by board name, in the order Detect tries them.
var Fetchers = map[string]Fetcher{
	"greenhouse": Greenhouse,
	"lever":      Lever,
	"ashby":      Ashby,
}

var order = []string{"greenhouse", "lever", "ashby"}

// Detect tries each board in order and returns the first with postings. If a
// board answers but is empty, it is returned when no board has postings.
func Detect(ctx context.Context, c *http.Client, slug, company string) (string, []Posting, error) {
	empty := ""
	var lastErr error = ErrNotFound
	for _, ats := range order {
		posts, err := Fetchers[ats](ctx, c, slug, company)
		if err == nil && len(posts) > 0 {
			return ats, posts, nil
		}
		if err == nil && empty == "" {
			empty = ats
		}
		if err != nil && !errors.Is(err, ErrNotFound) {
			lastErr = err
		}
	}
	if empty != "" {
		return empty, nil, nil
	}
	return "", nil, lastErr
}

func getJSON(ctx context.Context, c *http.Client, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		// Some boards answer 200 with an error object for unknown slugs.
		return ErrNotFound
	}
	return nil
}

func Greenhouse(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	var body struct {
		Jobs []struct {
			Title       string `json:"title"`
			AbsoluteURL string `json:"absolute_url"`
			Content     string `json:"content"`
			UpdatedAt   string `json:"updated_at"`
			Location    struct {
				Name string `json:"name"`
			} `json:"location"`
		} `json:"jobs"`
	}
	if err := getJSON(ctx, c, GreenhouseBase+"/v1/boards/"+slug+"/jobs?content=true", &body); err != nil {
		return nil, err
	}
	out := make([]Posting, 0, len(body.Jobs))
	for _, j := range body.Jobs {
		out = append(out, Posting{
			Title: j.Title, Company: company, Location: j.Location.Name, URL: j.AbsoluteURL,
			// Greenhouse escapes its HTML content once more.
			Description: StripHTML(html.UnescapeString(j.Content)),
			Source:      "greenhouse", PostedAt: utc(j.UpdatedAt),
			Remote: containsFold(j.Location.Name, "remote"),
		})
	}
	return out, nil
}

func Lever(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	var body []struct {
		Text             string `json:"text"`
		HostedURL        string `json:"hostedUrl"`
		DescriptionPlain string `json:"descriptionPlain"`
		AdditionalPlain  string `json:"additionalPlain"`
		CreatedAt        int64  `json:"createdAt"`
		WorkplaceType    string `json:"workplaceType"`
		Categories       struct {
			Location string `json:"location"`
		} `json:"categories"`
		Lists []struct {
			Text    string `json:"text"`
			Content string `json:"content"`
		} `json:"lists"`
	}
	if err := getJSON(ctx, c, LeverBase+"/v0/postings/"+slug+"?mode=json", &body); err != nil {
		return nil, err
	}
	out := make([]Posting, 0, len(body))
	for _, j := range body {
		var b strings.Builder
		b.WriteString(j.DescriptionPlain)
		for _, l := range j.Lists {
			b.WriteString("\n\n" + l.Text + "\n" + StripHTML(l.Content))
		}
		b.WriteString("\n\n" + j.AdditionalPlain)
		posted := ""
		if j.CreatedAt > 0 {
			posted = time.UnixMilli(j.CreatedAt).UTC().Format(time.RFC3339)
		}
		out = append(out, Posting{
			Title: j.Text, Company: company, Location: j.Categories.Location, URL: j.HostedURL,
			Description: strings.TrimSpace(b.String()), Source: "lever", PostedAt: posted,
			Remote: j.WorkplaceType == "remote" || containsFold(j.Categories.Location, "remote"),
		})
	}
	return out, nil
}

func Ashby(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	var body struct {
		Jobs []struct {
			Title            string `json:"title"`
			Location         string `json:"location"`
			JobURL           string `json:"jobUrl"`
			DescriptionPlain string `json:"descriptionPlain"`
			PublishedAt      string `json:"publishedAt"`
			IsRemote         bool   `json:"isRemote"`
		} `json:"jobs"`
	}
	if err := getJSON(ctx, c, AshbyBase+"/posting-api/job-board/"+slug, &body); err != nil {
		return nil, err
	}
	out := make([]Posting, 0, len(body.Jobs))
	for _, j := range body.Jobs {
		out = append(out, Posting{
			Title: j.Title, Company: company, Location: j.Location, URL: j.JobURL,
			Description: j.DescriptionPlain, Source: "ashby", PostedAt: utc(j.PublishedAt),
			Remote: j.IsRemote || containsFold(j.Location, "remote"),
		})
	}
	return out, nil
}

var (
	tagRe   = regexp.MustCompile(`<[^>]*>`)
	spaceRe = regexp.MustCompile(`[ \t]+`)
	blankRe = regexp.MustCompile(`\n\s*\n+`)
)

// StripHTML turns HTML into plain text with paragraph breaks kept.
func StripHTML(s string) string {
	s = strings.NewReplacer("</p>", "\n\n", "<br>", "\n", "<br/>", "\n", "<br />", "\n", "</li>", "\n").Replace(s)
	s = html.UnescapeString(tagRe.ReplaceAllString(s, " "))
	s = spaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(blankRe.ReplaceAllString(s, "\n\n"))
}

// utc converts an RFC 3339 time to UTC without fractions (the job API's format).
func utc(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), sub)
}
