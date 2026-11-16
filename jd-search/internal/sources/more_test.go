package sources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	return s
}

func TestWorkdayPagesAndDescribes(t *testing.T) {
	var posts int
	s := serve(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/wday/cxs/acme/External/jobs":
			posts++
			var in struct{ Offset int }
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in.Offset == 0 {
				jobs := make([]map[string]string, 20)
				for i := range jobs {
					jobs[i] = map[string]string{"title": "SDE 3", "externalPath": "/job/Pune/SDE_JR1", "locationsText": "Pune"}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"total": 21, "jobPostings": jobs})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"total": 21, "jobPostings": []map[string]string{
				{"title": "Engineering Manager", "externalPath": "/job/Remote/EM_JR2", "locationsText": "India Remote"}}})
		case r.URL.Path == "/wday/cxs/acme/External/job/Remote/EM_JR2":
			_ = json.NewEncoder(w).Encode(map[string]any{"jobPostingInfo": map[string]string{
				"jobDescription": "<p>Lead</p><p>Hire</p>", "location": "India Remote", "startDate": "2026-10-20"}})
		default:
			http.NotFound(w, r)
		}
	})
	old := WorkdayHost
	WorkdayHost = func(string) string { return s.URL }
	defer func() { WorkdayHost = old }()

	got, err := Workday(context.Background(), s.Client(), "acme.wd3/External", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 21 || posts != 2 {
		t.Fatalf("got %d postings in %d pages, want 21 in 2", len(got), posts)
	}
	last := got[20]
	if !last.Remote || last.Description != "" || last.Describe == nil {
		t.Fatalf("list posting: %+v", last)
	}
	d, err := last.Describe(context.Background())
	if err != nil || d.Description != "Lead\n\nHire" || d.PostedAt != "2026-10-20T00:00:00Z" {
		t.Fatalf("describe: %+v %v", d, err)
	}
	if _, err := Workday(context.Background(), s.Client(), "acme", "Acme"); err == nil {
		t.Fatal("a slug without /Site must fail")
	}
}

func TestSmartRecruitersUnknownCompanyIsNotFound(t *testing.T) {
	s := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/companies/acme/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"totalFound": 1, "content": []map[string]any{{
				"id": "6000", "name": "Software Dev Engineer III", "releasedDate": "2026-10-01T10:00:00.000Z",
				"ref":      "http://" + r.Host + "/v1/companies/acme/postings/6000",
				"location": map[string]any{"city": "Bengaluru", "country": "in"}}}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"totalFound": 0, "content": []any{}})
	})
	old := SmartRecruitersBase
	SmartRecruitersBase = s.URL
	defer func() { SmartRecruitersBase = old }()

	got, err := SmartRecruiters(context.Background(), s.Client(), "acme", "Acme")
	if err != nil || len(got) != 1 || got[0].Location != "Bengaluru, IN" || got[0].PostedAt != "2026-10-01T10:00:00Z" {
		t.Fatalf("got %+v %v", got, err)
	}
	if _, err := SmartRecruiters(context.Background(), s.Client(), "nobody", "Nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown company: %v, want ErrNotFound", err)
	}
}

func TestDetectNotFoundSaysWhatWasTried(t *testing.T) {
	s := serve(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	old := [3]string{GreenhouseBase, LeverBase, AshbyBase}
	GreenhouseBase, LeverBase, AshbyBase = s.URL, s.URL, s.URL
	defer func() { GreenhouseBase, LeverBase, AshbyBase = old[0], old[1], old[2] }()

	_, _, err := Detect(context.Background(), s.Client(), "zepto", "Zepto")
	if !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), `greenhouse, lever, ashby as "zepto"`) || !strings.Contains(err.Error(), "prefs company") {
		t.Fatalf("got %v", err)
	}
}

// The crawler is a separate program; a shell script stands in for it.
func fakeCrawler(t *testing.T, list string) {
	t.Helper()
	old := CrawlerCmd
	CrawlerCmd = []string{"sh", "-c", `if [ "$1" = list ]; then echo '` + list + `'; else echo '{"description":"Build APIs","location":"Bengaluru"}'; fi`, "crawler"}
	t.Cleanup(func() { CrawlerCmd = old })
}

func TestCareersJobLinks(t *testing.T) {
	fakeCrawler(t, `{"jobs":[{"title":"Senior Software Engineer","url":"https://acme.com/careers/details/1","location":""}]}`)
	got, err := Careers(context.Background(), http.DefaultClient, "https://acme.com/careers", "Acme")
	if err != nil || len(got) != 1 || got[0].Source != "careers" || got[0].Describe == nil {
		t.Fatalf("got %+v %v", got, err)
	}
	d, err := got[0].Describe(context.Background())
	if err != nil || d.Description != "Build APIs" || d.Location != "Bengaluru" {
		t.Fatalf("describe: %+v %v", d, err)
	}
}

func TestCareersBlockedAndBoardBehindPage(t *testing.T) {
	fakeCrawler(t, `{"blocked":"status 403"}`)
	if _, err := Careers(context.Background(), http.DefaultClient, "https://acme.com/careers", "Acme"); err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("blocked: %v", err)
	}
	s := serve(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"jobs": []map[string]any{{"title": "SDE 3", "absolute_url": "https://x", "location": map[string]string{"name": "Pune"}}}})
	})
	old := GreenhouseBase
	GreenhouseBase = s.URL
	defer func() { GreenhouseBase = old }()
	fakeCrawler(t, `{"ats":{"name":"greenhouse","slug":"acmeinc"}}`)
	got, err := Careers(context.Background(), s.Client(), "https://acme.com/careers", "Acme")
	if err != nil || len(got) != 1 || got[0].Source != "greenhouse" {
		t.Fatalf("board behind page: %+v %v", got, err)
	}
}
