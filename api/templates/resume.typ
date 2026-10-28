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

// Section title: small caps with a rule under it.
#let section(title) = {
  v(8pt)
  text(weight: 700, size: 11pt, smallcaps(title))
  v(-8pt)
  line(length: 100%, stroke: 0.6pt)
  v(-2pt)
}

// Two lines: bold left / right on top, plain left / italic right below. One line when
// the bottom is empty (a career break).
#let entry(top-left, top-right, bottom-left, bottom-right) = {
  block(above: 0.9em, below: 0.5em, breakable: false)[
    #strong(top-left) #h(1fr) #top-right
    #if bottom-left != "" or bottom-right != "" [
      \ #bottom-left #h(1fr) #emph(bottom-right)
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
    entry(e.title, e.dates, e.company, e.location)
    if e.bullets.len() > 0 { bullets(e.bullets) }
  }
}

#if data.projects.len() > 0 {
  section("Projects")
  for p in data.projects {
    entry(p.title, p.dates, p.company, p.location)
    bullets(p.bullets)
  }
}

#if data.education.len() > 0 {
  section("Education")
  for e in data.education {
    entry(e.school, e.dates, e.degree, "")
    if e.details.len() > 0 { bullets(e.details) }
  }
}

#if data.skills.len() > 0 {
  section("Skills")
  data.skills.join(", ")
}
