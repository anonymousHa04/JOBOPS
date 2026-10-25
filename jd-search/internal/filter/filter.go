// Package filter loads the user's preferences and decides which postings fit.
package filter

import (
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"jobops/jd-search/internal/sources"
)

// Prefs mirrors profile/preferences.yaml (the fields the search uses).
type Prefs struct {
	Compensation struct {
		Min float64 `yaml:"min"`
	} `yaml:"compensation"`
	Roles []struct {
		Title   string   `yaml:"title"`
		Aliases []string `yaml:"aliases"`
	} `yaml:"roles"`
	Seniority struct {
		Exclude []string `yaml:"exclude"`
	} `yaml:"seniority"`
	Location struct {
		Cities []string `yaml:"cities"`
		Remote bool     `yaml:"remote"`
		Hybrid bool     `yaml:"hybrid"`
		Onsite bool     `yaml:"onsite"`
	} `yaml:"location"`
	Companies struct {
		Include []Company `yaml:"include"`
		Exclude []string  `yaml:"exclude"`
	} `yaml:"companies"`
}

type Company struct {
	Name string `yaml:"name"`
	Slug string `yaml:"slug"`
	ATS  string `yaml:"ats"`
}

func Load(path string) (Prefs, error) {
	var p Prefs
	b, err := os.ReadFile(path)
	if err != nil {
		return p, err
	}
	return p, yaml.Unmarshal(b, &p)
}

// Remote locations that include India.
var openRe = regexp.MustCompile(`\b(india|anywhere|worldwide|global|apac|asia)\b`)

// Match reports whether a posting fits; reason names the first failed check.
func Match(p Prefs, post sources.Posting) (bool, string) {
	title := strings.ToLower(post.Title)
	if !titleMatches(p, title) {
		return false, "title"
	}
	for _, w := range p.Seniority.Exclude {
		if hasWord(title, strings.ToLower(w)) {
			return false, "seniority"
		}
	}
	if !locationMatches(p, post) {
		return false, "location"
	}
	return true, ""
}

func titleMatches(p Prefs, title string) bool {
	for _, r := range p.Roles {
		for _, name := range append([]string{r.Title}, r.Aliases...) {
			if hasWord(title, strings.ToLower(name)) {
				return true
			}
		}
	}
	return false
}

func locationMatches(p Prefs, post sources.Posting) bool {
	loc := strings.ToLower(post.Location)
	for _, c := range p.Location.Cities {
		if strings.Contains(loc, strings.ToLower(c)) {
			return p.Location.Onsite || p.Location.Hybrid || p.Location.Remote
		}
	}
	if !p.Location.Remote || !(post.Remote || strings.Contains(loc, "remote")) {
		return false
	}
	// Remote counts only when it is open to India; "Remote - Texas" is not.
	if openRe.MatchString(loc) {
		return true
	}
	return strings.Trim(strings.ReplaceAll(loc, "remote", ""), " -,()/") == ""
}

// hasWord matches phrase in s on word boundaries ("sde i" does not match "sde ii").
func hasWord(s, phrase string) bool {
	if phrase == "" {
		return false
	}
	re, err := regexp.Compile(`(^|[^a-z0-9])` + regexp.QuoteMeta(phrase) + `($|[^a-z0-9])`)
	return err == nil && re.MatchString(s)
}
