package sources

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Boards without a list-with-descriptions API: their postings carry Describe, which
// fetches the description (and location, when the list has none) only for postings that
// pass the title filter.

var (
	SmartRecruitersBase = "https://api.smartrecruiters.com"
	// WorkdayHost builds a Workday host from "tenant.wdN"; tests point it at a server.
	WorkdayHost = func(tenantWd string) string { return "https://" + tenantWd + ".myworkdayjobs.com" }
	// CrawlerCmd runs the careers-page crawler (api/src/careers/crawl.ts).
	CrawlerCmd = []string{"node", "../api/src/careers/crawl.ts"}
)

func init() {
	Fetchers["workday"] = Workday
	Fetchers["smartrecruiters"] = SmartRecruiters
	Fetchers["careers"] = Careers
}

func postJSON(ctx context.Context, c *http.Client, url string, in, out any) error {
	b, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnprocessableEntity {
		return ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("POST %s: status %d", url, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// Workday: slug is "tenant.wdN/Site", as in https://tenant.wdN.myworkdayjobs.com/Site.
func Workday(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	hostPart, site, ok := strings.Cut(slug, "/")
	tenant, _, _ := strings.Cut(hostPart, ".")
	if !ok || site == "" || tenant == "" {
		return nil, fmt.Errorf("workday slug %q: want tenant.wdN/Site", slug)
	}
	api := WorkdayHost(hostPart) + "/wday/cxs/" + tenant + "/" + site
	var out []Posting
	for offset := 0; ; offset += 20 {
		var page struct {
			Total int `json:"total"`
			Jobs  []struct {
				Title         string `json:"title"`
				ExternalPath  string `json:"externalPath"`
				LocationsText string `json:"locationsText"`
			} `json:"jobPostings"`
		}
		in := map[string]any{"appliedFacets": map[string]any{}, "limit": 20, "offset": offset, "searchText": ""}
		if err := postJSON(ctx, c, api+"/jobs", in, &page); err != nil {
			return nil, err
		}
		for _, j := range page.Jobs {
			detail := api + j.ExternalPath
			out = append(out, Posting{
				Title: j.Title, Company: company, Location: j.LocationsText,
				URL: WorkdayHost(hostPart) + "/" + site + j.ExternalPath, Source: "workday",
				Remote: containsFold(j.LocationsText, "remote"),
				Describe: func(ctx context.Context) (Details, error) {
					var d struct {
						Info struct {
							Description string `json:"jobDescription"`
							Location    string `json:"location"`
							StartDate   string `json:"startDate"`
						} `json:"jobPostingInfo"`
					}
					if err := getJSON(ctx, c, detail, &d); err != nil {
						return Details{}, err
					}
					posted := ""
					if t, err := time.Parse("2006-01-02", d.Info.StartDate); err == nil {
						posted = t.UTC().Format(time.RFC3339)
					}
					return Details{Description: StripHTML(d.Info.Description), Location: d.Info.Location, PostedAt: posted}, nil
				},
			})
		}
		if len(page.Jobs) == 0 || offset+20 >= page.Total {
			return out, nil
		}
	}
}

func SmartRecruiters(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	var out []Posting
	for offset := 0; ; offset += 100 {
		var page struct {
			Total   int `json:"totalFound"`
			Content []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Released string `json:"releasedDate"`
				Ref      string `json:"ref"`
				Location struct {
					City    string `json:"city"`
					Country string `json:"country"`
					Remote  bool   `json:"remote"`
				} `json:"location"`
			} `json:"content"`
		}
		url := fmt.Sprintf("%s/v1/companies/%s/postings?limit=100&offset=%d", SmartRecruitersBase, slug, offset)
		if err := getJSON(ctx, c, url, &page); err != nil {
			return nil, err
		}
		// Unknown companies answer 200 with nothing in them.
		if offset == 0 && page.Total == 0 {
			return nil, ErrNotFound
		}
		for _, j := range page.Content {
			ref := j.Ref
			loc := strings.Trim(strings.Join([]string{j.Location.City, strings.ToUpper(j.Location.Country)}, ", "), ", ")
			if j.Location.Remote {
				loc = strings.TrimPrefix(loc+", Remote", ", ")
			}
			out = append(out, Posting{
				Title: j.Name, Company: company, Location: loc,
				URL:    "https://jobs.smartrecruiters.com/" + slug + "/" + j.ID,
				Source: "smartrecruiters", PostedAt: utc(j.Released), Remote: j.Location.Remote,
				Describe: func(ctx context.Context) (Details, error) {
					var d struct {
						Ad struct {
							Sections map[string]struct {
								Title string `json:"title"`
								Text  string `json:"text"`
							} `json:"sections"`
						} `json:"jobAd"`
					}
					if err := getJSON(ctx, c, ref, &d); err != nil {
						return Details{}, err
					}
					var b strings.Builder
					for _, k := range []string{"companyDescription", "jobDescription", "qualifications", "additionalInformation"} {
						if s, ok := d.Ad.Sections[k]; ok && s.Text != "" {
							b.WriteString(s.Title + "\n" + StripHTML(s.Text) + "\n\n")
						}
					}
					return Details{Description: strings.TrimSpace(b.String())}, nil
				},
			})
		}
		if len(page.Content) == 0 || offset+100 >= page.Total {
			return out, nil
		}
	}
}

// Careers: slug is a careers page URL. The crawler opens it in a browser; when the page
// loads its jobs from a known board, that board's API is used instead (cleaner data).
func Careers(ctx context.Context, c *http.Client, slug, company string) ([]Posting, error) {
	var list struct {
		ATS *struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		} `json:"ats"`
		Jobs []struct {
			Title    string `json:"title"`
			URL      string `json:"url"`
			Location string `json:"location"`
		} `json:"jobs"`
		Blocked string `json:"blocked"`
	}
	if err := crawl(ctx, 3*time.Minute, &list, "list", slug); err != nil {
		return nil, err
	}
	if list.Blocked != "" {
		return nil, fmt.Errorf("careers page blocked automated access (%s); not retried", list.Blocked)
	}
	if list.ATS != nil {
		f, ok := Fetchers[list.ATS.Name]
		if !ok || list.ATS.Name == "careers" {
			return nil, fmt.Errorf("careers page uses %s (%s), which has no fetcher", list.ATS.Name, list.ATS.Slug)
		}
		posts, err := f(ctx, c, list.ATS.Slug, company)
		if err != nil {
			return nil, fmt.Errorf("careers page uses %s/%s: %w", list.ATS.Name, list.ATS.Slug, err)
		}
		return posts, nil
	}
	if len(list.Jobs) == 0 {
		return nil, fmt.Errorf("no job links found on %s", slug)
	}
	out := make([]Posting, 0, len(list.Jobs))
	for _, j := range list.Jobs {
		url := j.URL
		out = append(out, Posting{
			Title: j.Title, Company: company, Location: j.Location, URL: url, Source: "careers",
			Remote: containsFold(j.Location, "remote"),
			Describe: func(ctx context.Context) (Details, error) {
				var d Details
				err := crawl(ctx, time.Minute, &d, "describe", url)
				return d, err
			},
		})
	}
	return out, nil
}

// crawl runs the crawler and decodes its JSON output.
func crawl(ctx context.Context, timeout time.Duration, out any, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, CrawlerCmd[0], append(CrawlerCmd[1:], args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		return fmt.Errorf("crawler %s: %v %s", args[0], err, msg)
	}
	return json.Unmarshal(stdout.Bytes(), out)
}
