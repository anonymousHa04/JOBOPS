Extract the requirements from this job description as JSON:

{
  "role": "",
  "seniority": "",
  "must_have": [],        // hard requirements
  "nice_to_have": [],
  "keywords": [],         // exact terms an ATS would scan for
  "themes": [],           // e.g. ownership, scale, cross-team collaboration
  "summary_variant": ""   // best match from: [list your variants]
}

Rules for must_have and nice_to_have:
- must_have: everything the JD states as required. Look in sections such as "Requirements",
  "Qualifications", "What you bring", "You have", "Minimum qualifications", and in sentences with
  "must", "required", "need", "strong experience in", "X+ years".
- Everything under a required heading is must_have, however it is worded ("experience with",
  "understanding of", "solid knowledge of").
- nice_to_have: only what the JD itself marks optional: "preferred", "bonus", "a plus", "nice to
  have", or a "Preferred qualifications" heading.
- A skill that appears only in the responsibilities, and is central to the work (named more
  than once, or the main tool of the job), is a must_have.
- Every item is a short phrase of at most 6 words, in English. Never copy a whole sentence.
- One requirement per item. Split long sentences and lists: "Python, Go and Kubernetes" is three items. Keep a real
  alternative together: "Java or Kotlin" is one item.
- Keep years and degrees with their subject: "5+ years backend development", "BS in Computer
  Science or equivalent".
- Do not leave out a requirement because it seems obvious or soft (communication, mentoring).
- Never put the same item in both lists. Never invent a requirement the JD does not state.

Rules for keywords:
- Use the JD's exact wording (ATS matching is literal): every tool, language, framework, cloud
  service, method, architecture, product area and certification it names. Take them from the
  whole JD: the role description and responsibilities as well as the requirements. Expect 15 to
  40 keywords for a full JD.
- Keep each item to a few words.
- Output only JSON, in English.

Example (a short JD and its answer):
JD: "Senior Backend Engineer. You will build payment APIs in Go and run them on Kubernetes.
Requirements: 5+ years building backend services; Go or Java; PostgreSQL and Redis; experience
with AWS. Nice to have: Terraform, Kafka, mentoring junior engineers."
Answer:
{"role": "Senior Backend Engineer", "seniority": "senior",
 "must_have": ["5+ years building backend services", "Go or Java", "PostgreSQL", "Redis", "AWS", "Kubernetes"],
 "nice_to_have": ["Terraform", "Kafka", "mentoring junior engineers"],
 "keywords": ["Go", "Java", "Kubernetes", "PostgreSQL", "Redis", "AWS", "Terraform", "Kafka", "payment APIs", "backend services"],
 "themes": ["payments", "backend reliability"], "summary_variant": "general"}

JD:
<<<
[paste JD]
>>>
