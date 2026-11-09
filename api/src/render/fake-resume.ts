// A made-up resume (the name is common but invented, so a parser that only accepts
// name-like text still reads it) for ATS checks on third-party sites (ats check --fake). Nothing here is
// a real person's data; the phone number has a valid Indian mobile format so a site that
// validates numbers checks the layout, not a fake-looking number.
import type { Bank, ResumeRecord } from "../profile/schema.ts";

const bullet = (id: string, text: string) => ({ id, text, short: text, tags: ["test"], impact: "medium" as const, source: "resume" as const });

export const fakeBank: Bank = {
  basics: {
    name: "Rohan Mehta", email: "rohan.mehta.test@example.com", phone: "+91 98765 43210", location: "Bengaluru, India",
    links: ["https://github.com/testperson"]
  },
  summaries: [{ id: "s1", variant: "backend", text: "Backend engineer with nine years of experience." }],
  roles: [
    {
      id: "acme", title: "Senior Software Engineer", company: "Acme Software (Client: Globex Corp)", location: "Bengaluru", dates: "Jan 2018 - Present",
      bullets: [
        bullet("acme-1", "Moved 20 services to Kubernetes, cutting deploy time 40%"),
        bullet("acme-2", "Built the TypeScript event pipeline for billing")
      ]
    },
    { id: "brk", title: "Career break (family relocation)", dates: "Mar 2017 - Dec 2017", kind: "break", bullets: [] },
    {
      id: "oldco", title: "Software Engineer", company: "OldCo Systems", location: "Pune", dates: "Jan 2014 - Feb 2017",
      bullets: [bullet("oldco-1", "Built internal reporting dashboards in React")]
    }
  ],
  projects: [],
  education: [{ id: "edu", degree: "BTech in Mechanical Engineering", school: "University of Mumbai", dates: "2010 - 2014", details: [] }],
  skills: { languages: ["TypeScript", "Go"], frameworks: ["React"], tools: ["Kubernetes", "PostgreSQL"], domains: [] },
  approved: true
};

export function fakeRecord(): ResumeRecord {
  return {
    resume_id: "fake-test-person",
    content: {
      summary_variant: "backend",
      summary_text: fakeBank.summaries[0].text,
      skills: ["TypeScript", "Go", "React", "Kubernetes", "PostgreSQL"],
      bullets: [...fakeBank.roles, ...fakeBank.projects].flatMap((e) => e.bullets.map((b) => ({ id: b.id, entry_id: e.id, text: b.text })))
    }
  } as unknown as ResumeRecord;
}
