package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLog(t *testing.T, logs, name, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(logs, name+".log"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	// Coder tasks have a context file; server logs and manual runs do not.
	if err := os.WriteFile(filepath.Join(logs, name+".context.status"), []byte("ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func state(t *testing.T, line string) string {
	t.Helper()
	f := strings.Fields(line)
	if len(f) < 3 {
		t.Fatalf("short line: %q", line)
	}
	return f[2]
}

func TestGrowingLogIsWorking(t *testing.T) {
	notifyOn = false
	logs := t.TempDir()
	windows := map[string]bool{"task-a": true}
	tasks := map[string]*task{}
	now := time.Now()
	writeLog(t, logs, "task-a", "starting\n")
	check(logs, tasks, false, windows, now)

	// Ten minutes later the log has grown: working, however long the gap.
	writeLog(t, logs, "task-a", "starting\nediting chat.js\n")
	lines := check(logs, tasks, false, windows, now.Add(10*time.Minute))
	if len(lines) != 1 || state(t, lines[0]) != "WORKING" {
		t.Fatalf("got %v, want one WORKING line", lines)
	}
}

func TestPromptAtEndOfLogIsStuck(t *testing.T) {
	notifyOn = false
	logs := t.TempDir()
	windows := map[string]bool{"task-b": true}
	tasks := map[string]*task{}
	now := time.Now()
	// aider's prompt as it appears in the log: colour codes, then "> " and blank lines.
	writeLog(t, logs, "task-b", "Readonly: .claude/agents/coder.md\n\x1b[1m> \x1b[0m\n\n\n   \n")
	check(logs, tasks, false, windows, now)

	lines := check(logs, tasks, false, windows, now.Add(time.Minute))
	if len(lines) != 1 || state(t, lines[0]) != "STUCK" {
		t.Fatalf("got %v, want one STUCK line", lines)
	}
}

func TestMissingPidAndWindowIsDead(t *testing.T) {
	notifyOn = false
	logs := t.TempDir()
	writeLog(t, logs, "task-c", "running\n")
	// pid 999999 does not exist, and there is no tmux window for the task.
	if err := os.WriteFile(filepath.Join(logs, "task-c.pid"), []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines := check(logs, map[string]*task{}, false, map[string]bool{}, time.Now())
	if len(lines) != 1 || state(t, lines[0]) != "DEAD" {
		t.Fatalf("got %v, want one DEAD line", lines)
	}
}

func TestFinishedAndHelperLogsAreSkipped(t *testing.T) {
	notifyOn = false
	logs := t.TempDir()
	writeLog(t, logs, "task-d", "done\n")
	os.WriteFile(filepath.Join(logs, "task-d.done"), nil, 0o644)
	writeLog(t, logs, "task-e.check", "check output\n")
	os.WriteFile(filepath.Join(logs, "llm-coder.log"), []byte("server\n"), 0o644)
	// An old coder log with no .done and nothing alive: a long-finished run.
	writeLog(t, logs, "task-f", "old\n")
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(filepath.Join(logs, "task-f.log"), old, old)
	if lines := check(logs, map[string]*task{}, false, map[string]bool{}, time.Now()); len(lines) != 0 {
		t.Fatalf("got %v, want no lines", lines)
	}
}
