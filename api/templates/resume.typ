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
#set page(paper: data.at("paper", default: "a4"), margin: (x: 0.65in, y: 0.6in), header: none, footer: none)
#set text(font: "New Computer Modern", size: 10pt, lang: "en", ligatures: false)
#set par(justify: false, leading: 0.75em)
// Room between bullets, so a resume reads as separate points, not one block.
#set list(indent: 0.6em, marker: [•], spacing: 0.7em)

// Section title: small caps with a rule under it. Sticky: it moves to the next page with
// the content after it, so a page never ends on a heading (parsers then split the
// section: a "Skills" title on page 1 with its list on page 2 read as no skills).
// The rule sits just under the title, and the block keeps a gap below it, so the first
// line of plain text (Summary, Skills) never runs into the rule.
#let section(title) = block(sticky: true, above: 16pt, below: 9pt)[
  #text(weight: 700, size: 11pt, smallcaps(title))
  #v(-7pt)
  #line(length: 100%, stroke: 0.6pt)
]

// Company first ("Acme, Bangalore"), then the title with its dates on the right, then
// bullets. ATS parsers anchor an entry on the line with its dates: lines above it are read
// as company and title, lines below as the description. With the title on top, the
// company and location ended up in the description; all on one line was worse (iCIMS lost
// employers). An entry with no company (a project) is one line: the title, bold, with dates.
// A client ("Client: Y") is a plain line under the title: in the company line iCIMS took it
// as the employer (2026-11-08). Career breaks are not on the PDF (render.ts).
// Dates follow the title after a fixed gap, never pushed to the right margin: text
// extractors read a right-aligned run as a separate column and put every date at the
// end. The gap (not a "|") keeps title and dates two items for parsers that split on it.
#let entry(org, place, role, when, client: "") = {
  let dated(r) = if when != "" [#r#h(2em)#when] else [#r]
  block(above: 1.3em, below: 0.7em, breakable: false)[
    #if org != "" [
      #strong(org)#if place != "" [, #place] \
      #dated(emph(role))
    ] else [
      #dated(strong(role))
    ]
    #if client != "" [ \ Client: #client]
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

// Skills near the top (Atlassian's CV tips); a short section never splits across pages,
// and box() keeps each skill on one line.
#if data.skills.len() > 0 {
  block(breakable: false)[
    #section("Skills")
    #data.skills.map(s => box(s)).join(", ")
  ]
}

#if data.experience.len() > 0 {
  section("Experience")
  for e in data.experience {
    entry(e.company, e.location, e.title, e.dates, client: e.at("client", default: ""))
    if e.bullets.len() > 0 { bullets(e.bullets) }
  }
}

#if data.projects.len() > 0 {
  section("Projects")
  for p in data.projects {
    entry(p.company, p.location, p.title, p.dates, client: p.at("client", default: ""))
    bullets(p.bullets)
  }
}

#if data.education.len() > 0 {
  block(breakable: false)[
    #section("Education")
    #for e in data.education {
      entry(e.school, "", e.degree, e.dates)
      if e.details.len() > 0 { bullets(e.details) }
    }
  ]
}
