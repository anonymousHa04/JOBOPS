package filter

import (
	"testing"

	"jobops/jd-search/internal/sources"
)

func TestMatch(t *testing.T) {
	var p Prefs
	p.Roles = append(p.Roles, struct {
		Title   string   `yaml:"title"`
		Aliases []string `yaml:"aliases"`
	}{Title: "Senior Software Engineer"})
	p.Seniority.Exclude = []string{"manager"}
	p.Location.Cities = []string{"Bangalore", "Bengaluru"}
	p.Location.Remote, p.Location.Onsite = true, true

	cases := []struct {
		title, loc, want string
	}{
		{"Senior Software Engineer, Backend", "Bengaluru, India", ""},
		{"Senior Software Engineer", "Remote - India", ""},
		{"Senior Software Engineer", "Remote", ""},
		{"Senior Software Engineer", "Remote - Texas", "location"},
		{"Senior Software Engineer Manager", "Bangalore", "seniority"},
		{"Software Engineer", "Bangalore", "title"},
	}
	for _, c := range cases {
		_, got := Match(p, sources.Posting{Title: c.title, Location: c.loc})
		if got != c.want {
			t.Errorf("%q @ %q: got %q, want %q", c.title, c.loc, got, c.want)
		}
	}
}
