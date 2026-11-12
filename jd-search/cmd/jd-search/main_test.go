package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"jobops/jd-search/internal/filter"
	"jobops/jd-search/internal/sources"
)

const prefsYAML = `companies:
  include:
    - { name: Acme, slug: acme, ats: auto }
    - { name: Rippling, slug: rip, ats: auto }
  exclude: [Rippling]
skip_keywords: [Java, scala]
`

// load writes prefsYAML to its own temp dir and loads it, so each subtest starts fresh.
func load(t *testing.T) (filter.Prefs, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "preferences.yaml")
	if err := os.WriteFile(path, []byte(prefsYAML), 0o644); err != nil {
		t.Fatalf("write preferences: %v", err)
	}
	p, err := filter.Load(path)
	if err != nil {
		t.Fatalf("load preferences: %v", err)
	}
	return p, path
}

func TestApplyRunFlags(t *testing.T) {
	javaPost := sources.Posting{Title: "Senior Engineer", Description: "We use java"}

	t.Run("only keeps one company with this run's slug and ats", func(t *testing.T) {
		p, _ := load(t)
		if err := applyRunFlags(&p, "rippling", "rippling", "ashby", ""); err != nil {
			t.Fatalf("applyRunFlags: %v", err)
		}
		if len(p.Companies.Include) != 1 {
			t.Fatalf("Include = %+v, want exactly one company", p.Companies.Include)
		}
		want := filter.Company{Name: "Rippling", Slug: "rippling", ATS: "ashby"}
		if got := p.Companies.Include[0]; got != want {
			t.Errorf("Include[0] = %+v, want %+v", got, want)
		}
		for _, name := range p.Companies.Exclude {
			if strings.EqualFold(name, "Rippling") {
				t.Errorf("Exclude still has Rippling: %v", p.Companies.Exclude)
			}
		}
	})

	t.Run("unknown company is an error", func(t *testing.T) {
		p, _ := load(t)
		err := applyRunFlags(&p, "Nope", "", "", "")
		if err == nil {
			t.Fatal("applyRunFlags returned nil for an unknown company")
		}
		if !strings.Contains(err.Error(), "no company Nope in preferences") {
			t.Errorf("error = %q, want it to contain %q", err, "no company Nope in preferences")
		}
	})

	t.Run("unskip removes words for this run only", func(t *testing.T) {
		p, _ := load(t)
		if got := filter.SkipKeyword(p, javaPost); got != "java" {
			t.Fatalf("SkipKeyword before unskip = %q, want %q", got, "java")
		}
		if err := applyRunFlags(&p, "", "", "", " JAVA "); err != nil {
			t.Fatalf("applyRunFlags: %v", err)
		}
		if got := filter.SkipKeyword(p, javaPost); got != "" {
			t.Errorf("SkipKeyword after unskip = %q, want \"\"", got)
		}
		if len(p.SkipKeywords) != 1 || p.SkipKeywords[0] != "scala" {
			t.Errorf("SkipKeywords = %v, want [scala]", p.SkipKeywords)
		}
	})

	t.Run("the preferences file is never written", func(t *testing.T) {
		p, path := load(t)
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read preferences: %v", err)
		}
		if err := applyRunFlags(&p, "rippling", "rippling", "ashby", ""); err != nil {
			t.Errorf("applyRunFlags only: %v", err)
		}
		if err := applyRunFlags(&p, "Nope", "", "", ""); err == nil {
			t.Error("applyRunFlags returned nil for an unknown company")
		}
		if err := applyRunFlags(&p, "", "", "", " JAVA "); err != nil {
			t.Errorf("applyRunFlags unskip: %v", err)
		}
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read preferences again: %v", err)
		}
		if string(before) != string(after) {
			t.Errorf("preferences file changed:\nbefore:\n%s\nafter:\n%s", before, after)
		}
	})
}
