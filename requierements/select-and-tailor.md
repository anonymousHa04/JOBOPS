You are tailoring a resume. Choose and lightly rewrite bullets from a
candidate's experience bank to match a job.

Job requirements:
[paste Prompt 2 JSON]

Candidate bullets (id | text | tags):
[paste shortlist]

Constraints:
- Pick up to [N] bullets per role, [M] total, to fit one page.
- Prioritize must_have coverage first, then high-impact bullets.
- Rewrite only to align wording with JD keywords where the original
  already supports it. Never add skills, tools, metrics, or scope the
  original doesn't state.
- Keep each bullet under [25] words, starting with a strong verb.

Output only JSON:
{
  "summary_variant": "",
  "include": [{"id": "", "text": "rewritten or original"}],
  "uncovered_requirements": [],   // must-haves no bullet supports
  "notes": ""                     // one line on any trade-off
}