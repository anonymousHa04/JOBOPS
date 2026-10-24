---
name: jobops-resume
description: Resume JobOps work in a new chat. Use at the start of every new session in this repo, and whenever the user asks what is done, where we left off, what is next, or the project status. Reads the handoff and checks live state read-only, then reports before changing anything.
---

# Resume JobOps

Goal: know what is done and where to start, without disturbing anything the
user or an earlier session left in place.

## Hard rule: read-only until the user confirms

Until the user says to proceed, do not edit, create, delete, stage, commit,
stash, reset, check out, or merge anything; do not start coders, tmux windows,
or downloads; do not restart Ollama. Uncommitted changes, extra branches,
worktrees, and running coders may be the user's work in progress: report them,
never "clean them up".

## Steps

1. Read `.claude/STATUS.md` (the handoff) and `.claude/agents/AGENTS.md` (the
   rules). Read README.md only for the milestone you are about to plan.
2. Check live state with read-only commands, in one call:

       git branch --show-current; git status --short; git log --oneline -5
       git worktree list; git stash list
       curl -s localhost:11434/api/version; ollama ps
       tmux list-windows -t jobops 2>/dev/null; pgrep -fl "Python.*(aider --model|mini -c)"
       ls .agent-logs 2>/dev/null | tail -5

3. Check the graph without rebuilding it:

       $(cat graphify-out/.graphify_python) -c "from graphify.detect import detect_incremental; from pathlib import Path; r=detect_incremental(Path('.')); print({k: len(v) for k, v in r.get('new_files', {}).items() if v}, len(r.get('deleted_files', [])))"

   Non-empty means the graph is behind; mention it, don't update it unprompted
   (Markdown re-extraction costs tens of thousands of tokens).
4. Compare live state with STATUS.md. Flag every difference: commits not in
   STATUS.md, uncommitted changes, running coder processes, worktrees named
   `jobops-mini-*`, a stopped Ollama. tmux windows that show "[finished - press
   Enter to close]" are done runs, not active work.
5. Report to the user, briefly:
   - done (milestones and last commit),
   - where to start (the "Where to start next" section),
   - open decisions from STATUS.md that need the user,
   - anything unexpected from step 4, with what you would do about it.
   Then ask how to proceed.

## After the user confirms

Follow AGENTS.md: plan the milestone once in `.claude/specs/plan-<milestone>.md`,
run it with `.claude/bin/run-plan.sh`, gate test tasks on user approval, update
the graph once at the end of the milestone, and update `.claude/STATUS.md`.
Never commit unless the user explicitly asks.
