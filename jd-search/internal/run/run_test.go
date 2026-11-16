package run

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"jobops/jd-search/internal/filter"
	"jobops/jd-search/internal/sources"
)

func prefs() filter.Prefs {
	var p filter.Prefs
	p.Roles = append(p.Roles, filter.Role{Title: "Senior Software Engineer"})
	p.Location.Cities = []string{"Bengaluru"}
	p.Location.Onsite = true
	return p
}

func posting(d sources.Details, err error) sources.Posting {
	return sources.Posting{Title: "Senior Software Engineer", Company: "Acme", Source: "careers",
		Describe: func(context.Context) (sources.Details, error) { return d, err }}
}

func TestSearchReportsEveryCompany(t *testing.T) {
	sources.Fetchers["fake-ok"] = func(ctx context.Context, c *http.Client, slug, company string) ([]sources.Posting, error) {
		return []sources.Posting{
			{Title: "Senior Software Engineer", Company: "Acme", Location: "Bengaluru", URL: "u1", Source: "fake", Description: "Build APIs"},
			{Title: "Intern", Company: "Acme", Location: "Bengaluru", URL: "u2", Source: "fake", Description: "x"},
		}, nil
	}
	sources.Fetchers["fake-err"] = func(ctx context.Context, c *http.Client, slug, company string) ([]sources.Posting, error) {
		return nil, errors.New("board down")
	}
	t.Cleanup(func() {
		delete(sources.Fetchers, "fake-ok")
		delete(sources.Fetchers, "fake-err")
	})

	p := prefs()
	p.Companies.Include = []filter.Company{
		{Name: "Acme", Slug: "acme", ATS: "fake-ok"},
		{Name: "Broken", Slug: "b", ATS: "fake-err"},
		{Name: "NoSlug", Slug: "", ATS: "auto"},
		{Name: "Gone", Slug: "g", ATS: "fake-ok"},
	}
	p.Companies.Exclude = []string{"Gone"}

	rep := Search(context.Background(), p, Options{DryRun: true, Workers: 2})

	rows := rep.CompaniesDetail
	if len(rows) != 4 {
		t.Fatalf("want 4 company rows, got %d: %+v", len(rows), rows)
	}
	for i, name := range []string{"Acme", "Broken", "Gone", "NoSlug"} {
		if rows[i].Name != name {
			t.Fatalf("row %d: want %q, got %q (rows must be sorted by name)", i, name, rows[i].Name)
		}
	}

	acme := rows[0]
	if acme.Status != "fetched" || acme.Board != "fake-ok" || acme.Postings != 2 || acme.Matched != 1 ||
		!slices.Equal(acme.Titles, []string{"Senior Software Engineer"}) {
		t.Fatalf("Acme: %+v", acme)
	}
	if broken := rows[1]; broken.Status != "unreachable" || !strings.Contains(broken.Error, "board down") {
		t.Fatalf("Broken: %+v", broken)
	}
	if gone := rows[2]; gone.Status != "excluded" {
		t.Fatalf("Gone: %+v", gone)
	}
	if noSlug := rows[3]; noSlug.Status != "no_slug" {
		t.Fatalf("NoSlug: %+v", noSlug)
	}

	if !slices.Equal(rep.Unreachable, []string{"Broken"}) {
		t.Fatalf("Unreachable: want [Broken], got %v", rep.Unreachable)
	}
	if rep.Companies != 2 {
		t.Fatalf("Companies: want 2, got %d", rep.Companies)
	}
}

func TestDescribeChecksTheLocationItFinds(t *testing.T) {
	p := posting(sources.Details{Description: "Build APIs", Location: "Bengaluru"}, nil)
	if ok, reason := filter.Match(prefs(), p); !ok {
		t.Fatalf("an unknown location must pass the first check: %s", reason)
	}
	got, ok, _ := describe(context.Background(), prefs(), p)
	if !ok || got.Description != "Build APIs" || got.Location != "Bengaluru" || got.Describe != nil {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
	if _, ok, reason := describe(context.Background(), prefs(), posting(sources.Details{Description: "x", Location: "Sydney"}, nil)); ok || reason != "location" {
		t.Fatalf("Sydney: ok=%v reason=%q", ok, reason)
	}
	if got, ok, _ := describe(context.Background(), prefs(), posting(sources.Details{Description: "x"}, nil)); !ok || got.Location != "" {
		t.Fatal("still unknown after describe: kept, location empty")
	}
	got, ok, _ = describe(context.Background(), prefs(), posting(sources.Details{Description: "Our team in Bengaluru builds"}, nil))
	if !ok || got.Location != "Bengaluru (from the description)" {
		t.Fatalf("city in the description: %+v ok=%v", got, ok)
	}
	if _, ok, reason := describe(context.Background(), prefs(), posting(sources.Details{}, errors.New("down"))); ok || reason != "describe" {
		t.Fatalf("failed describe: ok=%v reason=%q", ok, reason)
	}
}
