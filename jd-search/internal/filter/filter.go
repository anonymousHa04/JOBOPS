// Package filter loads the user's preferences and decides which postings fit.
package filter

import (
	"os"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"jobops/jd-search/internal/sources"
)

// Prefs mirrors profile/preferences.yaml (the fields the search uses).
type Prefs struct {
	Compensation struct {
		Currency string  `yaml:"currency"` // only INR (LPA) is checked
		Min      float64 `yaml:"min"`      // lakh per annum
		// Posts without an INR salary are kept unless this is false (absent = true).
		KeepIfUnlisted *bool `yaml:"keep_if_unlisted"`
	} `yaml:"compensation"`
	Roles     []Role `yaml:"roles"`
	Seniority struct {
		// The title needs one of these words, or a level (III, 3), unless the role has any_level.
		Include []string `yaml:"include"`
		Exclude []string `yaml:"exclude"`
	} `yaml:"seniority"`
	TitleFilter struct {
		// A title naming an Other language is skipped unless it also names one of Mine.
		Mine  []string `yaml:"my_languages"`
		Other []string `yaml:"other_languages"`
	} `yaml:"title_filter"`
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

type Role struct {
	Title    string   `yaml:"title"`
	Aliases  []string `yaml:"aliases"`
	AnyLevel bool     `yaml:"any_level"`
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

// Match reports whether a posting fits; reason names the first failed check:
// title, seniority, seniority_include, language, location, compensation.
// A posting whose list gives no location (and that will be described) is not rejected for it yet;
// the pay check runs only once there is a description.
func Match(p Prefs, post sources.Posting) (bool, string) {
	unknown := post.Location == "" && post.Describe != nil
	return match(p, post, unknown)
}

// Stored is a job already in the database, checked again before a batch takes it.
type Stored struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Location    string `json:"location"`
	Description string `json:"description"`
}

// CheckStored applies Match to a stored job. A stored job without a location passed the search
// with an unknown location, so the location check is skipped for it.
func CheckStored(p Prefs, j Stored) (bool, string) {
	post := sources.Posting{Title: j.Title, Location: j.Location, Description: j.Description,
		Remote: strings.Contains(strings.ToLower(j.Location), "remote")}
	return match(p, post, j.Location == "")
}

func match(p Prefs, post sources.Posting, locationUnknown bool) (bool, string) {
	title := strings.ToLower(post.Title)
	ok, anyLevel := titleMatches(p, title)
	if !ok {
		return false, "title"
	}
	for _, w := range p.Seniority.Exclude {
		if hasWord(title, strings.ToLower(w)) {
			return false, "seniority"
		}
	}
	if !anyLevel && !hasLevel(p, title) {
		return false, "seniority_include"
	}
	if !languageOK(p, title) {
		return false, "language"
	}
	if !locationUnknown && !locationMatches(p, post) {
		return false, "location"
	}
	if post.Description != "" && !PayOK(p, post.Description) {
		return false, "compensation"
	}
	return true, ""
}

// titleMatches: the title names a role or alias; anyLevel when a matching role has any_level.
func titleMatches(p Prefs, title string) (ok, anyLevel bool) {
	for _, r := range p.Roles {
		for _, name := range append([]string{r.Title}, r.Aliases...) {
			if hasWord(title, strings.ToLower(name)) {
				ok = true
				anyLevel = anyLevel || r.AnyLevel
			}
		}
	}
	return ok, anyLevel
}

var levelRe = regexp.MustCompile(`(^|[^a-z0-9])(iii|3)($|[^a-z0-9])`)

// hasLevel: no include list means no check; otherwise an include word or level III / 3.
func hasLevel(p Prefs, title string) bool {
	if len(p.Seniority.Include) == 0 || levelRe.MatchString(title) {
		return true
	}
	for _, w := range p.Seniority.Include {
		if hasWord(title, strings.ToLower(w)) {
			return true
		}
	}
	return false
}

// languageOK: false when the title names an Other language and none of Mine.
func languageOK(p Prefs, title string) bool {
	for _, w := range p.TitleFilter.Mine {
		if hasWord(title, strings.ToLower(w)) {
			return true
		}
	}
	for _, w := range p.TitleFilter.Other {
		if hasWord(title, strings.ToLower(w)) {
			return false
		}
	}
	return true
}

// PayOK: false when the description states an INR salary whose highest figure is below the
// minimum, or states none and keep_if_unlisted is false. Other currencies count as unlisted.
func PayOK(p Prefs, description string) bool {
	if p.Compensation.Min <= 0 || (p.Compensation.Currency != "" && !strings.EqualFold(p.Compensation.Currency, "INR")) {
		return true
	}
	lpa, found := PayLPA(description)
	if !found {
		return p.Compensation.KeepIfUnlisted == nil || *p.Compensation.KeepIfUnlisted
	}
	return lpa >= p.Compensation.Min
}

var (
	// "40 LPA", "40-55 LPA", "40 to 55 lakhs", "₹45L", "INR 40,00,000", "Rs. 1.2 Cr".
	payRangeRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|lacs?)\b`)
	payOneRe   = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|lacs?)\b`)
	payRupeeRe = regexp.MustCompile(`(?:₹|\binr|\brs\.?)\s*([\d,]+(?:\.\d+)?)\s*(l\b|lakhs?|lacs?|lpa|cr\b|crores?)?`)
	// A figure counts as pay only with one of these words shortly before it
	// ("5 lakh health cover" is not a salary).
	payWords = []string{"salary", "ctc", "compensation", "pay", "package", "base", "lpa", "per annum", "range"}
)

// PayLPA returns the highest INR salary figure (lakh per annum) the description states.
func PayLPA(description string) (float64, bool) {
	d := strings.ToLower(description)
	best, found := 0.0, false
	take := func(start int, v float64) {
		if v < 3 || v > 1000 || !nearPayWord(d, start) {
			return
		}
		if v > best {
			best = v
		}
		found = true
	}
	for _, m := range payRangeRe.FindAllStringSubmatchIndex(d, -1) {
		take(m[0], num(d[m[4]:m[5]]))
	}
	for _, m := range payOneRe.FindAllStringSubmatchIndex(d, -1) {
		take(m[0], num(d[m[2]:m[3]]))
	}
	for _, m := range payRupeeRe.FindAllStringSubmatchIndex(d, -1) {
		v := num(strings.ReplaceAll(d[m[2]:m[3]], ",", ""))
		unit := ""
		if m[4] >= 0 {
			unit = d[m[4]:m[5]]
		}
		switch {
		case strings.HasPrefix(unit, "cr"):
			v *= 100
		case unit != "":
			// already lakh
		case v >= 100000:
			v /= 100000
		default:
			continue
		}
		take(m[0], v)
	}
	return best, found
}

func nearPayWord(d string, start int) bool {
	from := start - 80
	if from < 0 {
		from = 0
	}
	window := d[from:min(len(d), start+40)]
	for _, w := range payWords {
		if hasWord(window, w) {
			return true
		}
	}
	return false
}

func num(s string) float64 {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
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
