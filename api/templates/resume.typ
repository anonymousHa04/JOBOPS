// JobOps resume template (ATS-safe). Adapted from stuxf/basic-typst-resume-template
// (typst package basic-resume 0.2.10, Unlicense): same plain single-column layout,
// changed for the rules in the m3-notes skill (gaps-and-rejection-risks.md, ATS parsing):
// - all content comes from data.json as plain strings, never typst markup;
// - one column, no tables, icons, images, header, or footer;
// - standard section titles, fixed here (never changed per JD);
// - links shown as full URLs, and no contact item ever wraps across lines;
// - ligatures off, no justification (no stretched or split words in extraction).
// Render: render.ts writes data.json next to a copy of this file and runs typst.

#let data = json("data.json")

#set document(author: data.name, title: data.name)
#set page(paper: data.at("paper", default: "a4"), margin: 0.5in, header: none, footer: none)
#set text(font: "New Computer Modern", size: 10pt, lang: "en", ligatures: false)
#set par(justify: false)
#set list(indent: 0.6em, marker: [•])

// Section title: small caps with a rule under it. Sticky: it moves to the next page with
// the content after it, so a page never ends on a heading (parsers then split the
// section: a "Skills" title on page 1 with its list on page 2 read as no skills).
#let section(title) = block(sticky: true, above: 8pt, below: 0pt)[
  #text(weight: 700, size: 11pt, smallcaps(title))
  #v(-8pt)
  #line(length: 100%, stroke: 0.6pt)
  #v(-2pt)
]

// Company first ("Acme, Bangalore"), then the title with its dates on the right, then
// bullets. ATS parsers (Workday) anchor an entry on the line with its dates: lines above
// it are read as company and title, lines below as the description. With the title on
// top, the company and location ended up in the description, and a career break's
// reason line was glued onto the next job's title. An entry with no company (a career
// break, a project) is one line: the title, bold, with its dates.
// Dates follow the title after a fixed gap, never pushed to the right margin: text
// extractors read a right-aligned run as a separate column and put every date at the
// end. The gap (not a "|") keeps title and dates two items for parsers that split on it.
#let entry(org, place, role, when) = {
  let dated(r) = if when != "" [#r#h(2em)#when] else [#r]
  block(above: 0.9em, below: 0.5em, breakable: false)[
    #if org != "" [
      #strong(org)#if place != "" [, #place] \
      #dated(emph(role))
    ] else [
      #dated(strong(role))
    ]
  ]
}

#let bullets(items) = list(..items.map(b => [#b]))

// Name and contact line.
#text(weight: 700, size: 20pt, data.name)
#v(-4pt)
#{
  // box() keeps each item (a URL above all) on one line.
  let plain = (data.phone, data.location, data.email).filter(x => x != "").map(x => box(x))
  let links = data.links.map(l => box(link(l.url, l.text)))
  (plain + links).join("  |  ")
}

#if data.summary != "" {
  section("Summary")
  data.summary
}

#if data.experience.len() > 0 {
  section("Experience")
  for e in data.experience {
    entry(e.company, e.location, e.title, e.dates)
    if e.bullets.len() > 0 { bullets(e.bullets) }
  }
}

#if data.projects.len() > 0 {
  section("Projects")
  for p in data.projects {
    entry(p.company, p.location, p.title, p.dates)
    bullets(p.bullets)
  }
}

// Short sections never split across pages.
#if data.education.len() > 0 {
  block(breakable: false)[
    #section("Education")
    #for e in data.education {
      entry(e.school, "", e.degree, e.dates)
      if e.details.len() > 0 { bullets(e.details) }
    }
  ]
}

#if data.skills.len() > 0 {
  block(breakable: false)[
    #section("Skills")
    #data.skills.join(", ")
  ]
}
