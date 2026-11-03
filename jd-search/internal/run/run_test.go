package run

import (
	"context"
	"errors"
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
