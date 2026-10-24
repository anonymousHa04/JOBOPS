# JobOps

At the start of every new session, run the `jobops-resume` skill before doing
anything else. It reads `.claude/STATUS.md` and checks the live state
read-only, then reports what is done and where to start.

- Rules for every agent: `.claude/agents/AGENTS.md`.
- Product scope and roadmap (source of truth): `README.md`.
- Keep `.claude/STATUS.md` current: update it at the end of each milestone.
