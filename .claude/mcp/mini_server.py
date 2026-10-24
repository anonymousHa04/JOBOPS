# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp>=2,<3"]
# ///
"""MCP server exposing the local mini-swe-agent coder to Claude Code.

Tools:
  run_mini  - run mini-swe-agent on a task in a throwaway worktree (via
              .claude/bin/run-mini.sh), merge the diff only if check.sh passes,
              and return the outcome.
  check     - run .claude/bin/check.sh and return the compact report.

Run: uv run --script .claude/mcp/mini_server.py   (registered in .mcp.json)
"""

import re
import subprocess
from pathlib import Path

from mcp.server.mcpserver import MCPServer

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / ".claude" / "bin"
TASK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TIMEOUT = 1200  # seconds, same limit as autofix.sh

server = MCPServer("mini-swe-agent")


def _valid_task_id(task_id: str) -> None:
    if not TASK_ID.match(task_id):
        raise ValueError("task_id must be lowercase letters, digits, and dashes")


def _tail(path: Path, lines: int) -> str:
    if not path.exists():
        return ""
    text = [l for l in path.read_text(errors="replace").splitlines() if l.strip()]
    return "\n".join(text[-lines:])


@server.tool()
def run_mini(task_id: str, task: str, files: list[str] | None = None) -> str:
    """Run the local mini-swe-agent coder (qwen2.5-coder:14b) on a task.

    It works in a throwaway git worktree, runs typecheck and tests there, and
    applies its diff to the main tree only if they pass and it changed only
    `files` (when given). Watch it live with `tmux attach -t jobops`.

    Args:
        task_id: short id, lowercase letters/digits/dashes, e.g. "m3-02-fix-hash".
        task: the full task description for the coder.
        files: repo-relative paths the coder may change; others block the merge.
    """
    _valid_task_id(task_id)
    for f in files or []:
        if f.startswith("/") or ".." in Path(f).parts:
            raise ValueError(f"files must be repo-relative: {f}")

    spec = ROOT / ".claude" / "specs" / f"{task_id}.md"
    spec.parent.mkdir(parents=True, exist_ok=True)
    spec.write_text(f"# Task {task_id}\n\n{task}\n")

    rel_spec = str(spec.relative_to(ROOT))
    subprocess.run([str(BIN / "run-mini.sh"), task_id, rel_spec, *(files or [])],
                   cwd=ROOT, check=True, capture_output=True, text=True)
    try:
        subprocess.run(["tmux", "wait-for", task_id], cwd=ROOT, timeout=TIMEOUT, check=True)
    except subprocess.TimeoutExpired:
        pid_file = ROOT / ".agent-logs" / f"{task_id}.pid"
        if pid_file.exists():
            pid = pid_file.read_text().strip()
            subprocess.run(["pkill", "-P", pid])
            subprocess.run(["kill", pid])
        subprocess.run(["tmux", "kill-window", "-t", f"jobops:{task_id}"])
        return f"TIMEOUT after {TIMEOUT}s; coder stopped.\n" + _tail(ROOT / ".agent-logs" / f"{task_id}.log", 10)

    log_tail = _tail(ROOT / ".agent-logs" / f"{task_id}.log", 12)
    return f"{log_tail}\n\n{check(task_id)}"


@server.tool()
def check(task_id: str) -> str:
    """Run typecheck and tests in the main tree; return the compact PASS/FAIL report."""
    _valid_task_id(task_id)
    out = subprocess.run([str(BIN / "check.sh"), task_id], cwd=ROOT,
                         capture_output=True, text=True)
    return out.stdout.strip() or out.stderr.strip()


if __name__ == "__main__":
    server.run()
