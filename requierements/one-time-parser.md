Convert the resume below into a YAML "experience bank" using exactly this schema:

basics: {name, email, phone, location, links: []}
summaries:
  - id, variant (e.g. backend, infra, ml), text
roles:
  - id, title, company, location, dates
    bullets:
      - id (format: <role-id>-<n>), text, short (max 15 words),
        tags (5-8 lowercase skills/themes), impact (high|medium|low)
projects: same structure as roles
education: [{id, degree, school, dates, details: []}]
skills: {languages: [], frameworks: [], tools: [], domains: []}

Rules:
- Preserve every fact, number, and metric exactly. Do not invent or embellish.
- "short" is a compressed version of the same bullet, not a new claim.
- Tags should include both specific tech (redis, kubernetes) and themes
  (leadership, performance, cost-reduction, mentoring).
- Mark impact as high only if the bullet has a measurable result.
- Output only valid YAML, no commentary.

Resume:
<<<
[paste text]
>>>