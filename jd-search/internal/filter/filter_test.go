package filter

import (
	"testing"

	"jobops/jd-search/internal/sources"
)

func TestMatch(t *testing.T) {
	var p Prefs
	p.Roles = append(p.Roles, Role{Title: "Senior Software Engineer"})
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

func searchPrefs() Prefs {
	var p Prefs
	p.Roles = []Role{
		{Title: "Senior Software Engineer", Aliases: []string{"Sr. Software Engineer", "Software Engineer III"}},
		{Title: "Forward Deployed Engineer", AnyLevel: true},
		{Title: "Senior AI Engineer", Aliases: []string{"Applied AI Engineer"}},
		{Title: "Senior C++ Engineer"},
		{Title: "Engineer"},
	}
	p.Seniority.Include = []string{"senior", "sr", "sde3", "lead", "founding"}
	p.Seniority.Exclude = []string{"staff", "test"}
	p.TitleFilter.Mine = []string{"typescript", "javascript", "python", "go", "c++"}
	p.TitleFilter.Other = []string{"java", "android", "kotlin", ".net"}
	p.Location.Cities = []string{"Bengaluru"}
	p.Location.Onsite = true
	p.Compensation.Currency = "INR"
	p.Compensation.Min = 40
	return p
}

func TestSeniorityIncludeAndLanguage(t *testing.T) {
	p := searchPrefs()
	cases := []struct{ title, want string }{
		{"Senior Software Engineer", ""},
		{"Sr. Software Engineer, Payments", ""},
		{"Software Engineer III", ""},
		{"Forward Deployed Engineer", ""},
		{"Applied AI Engineer", "seniority_include"},
		{"Senior Software Engineer in Test", "seniority"},
		{"Senior Staff Software Engineer", "seniority"},
		{"Senior Software Engineer - Java Developer", "language"},
		{"Senior Software Engineer - Android", "language"},
		{"Senior Software Engineer, .NET", "language"},
		{"Senior Software Engineer (Fullstack Javascript Engineer)", ""},
		{"Senior Java and Python Engineer", ""},
		{"Senior C++ Engineer", ""},
	}
	for _, c := range cases {
		_, got := Match(p, sources.Posting{Title: c.title, Location: "Bengaluru"})
		if got != c.want {
			t.Errorf("%q: got %q, want %q", c.title, got, c.want)
		}
	}
}

func TestPay(t *testing.T) {
	p := searchPrefs()
	no := false
	cases := []struct {
		desc string
		keep *bool
		want bool
	}{
		{"Compensation: 30 LPA fixed.", nil, false},
		{"Salary range 45-60 LPA plus stock.", nil, true},
		{"CTC: ₹42,00,000 per annum.", nil, true},
		{"Base pay INR 35,00,000.", nil, false},
		{"Package up to 1.2 Cr.", nil, true},
		{"We build payment systems. Health cover of 5 lakhs for family.", nil, true}, // not a salary
		{"Great team, no salary stated.", nil, true},
		{"Great team, no salary stated.", &no, false},
		{"The base salary range is $150,000 - $180,000.", nil, true}, // USD: unlisted
	}
	for _, c := range cases {
		p.Compensation.KeepIfUnlisted = c.keep
		if got := PayOK(p, c.desc); got != c.want {
			lpa, found := PayLPA(c.desc)
			t.Errorf("%q (keep %v): got %v, want %v (lpa %v found %v)", c.desc, c.keep, got, c.want, lpa, found)
		}
	}
	p.Compensation.KeepIfUnlisted = nil
	_, got := Match(p, sources.Posting{Title: "Senior Software Engineer", Location: "Bengaluru", Description: "Salary: 25 LPA"})
	if got != "compensation" {
		t.Errorf("match with low pay: got %q, want compensation", got)
	}
}

func TestCheckStored(t *testing.T) {
	p := searchPrefs()
	cases := []struct {
		job  Stored
		want string
	}{
		{Stored{ID: "a", Title: "Senior Software Engineer", Location: "Bengaluru"}, ""},
		{Stored{ID: "b", Title: "Senior Software Engineer", Location: ""}, ""}, // unknown location passed the search
		{Stored{ID: "c", Title: "Senior Software Engineer in Test", Location: "Bengaluru"}, "seniority"},
		{Stored{ID: "d", Title: "Senior Software Engineer", Location: "Pune"}, "location"},
		{Stored{ID: "e", Title: "Senior Software Engineer", Location: "Bengaluru", Description: "CTC 20 LPA"}, "compensation"},
	}
	for _, c := range cases {
		if _, got := CheckStored(p, c.job); got != c.want {
			t.Errorf("%s %q: got %q, want %q", c.job.ID, c.job.Title, got, c.want)
		}
	}
}
