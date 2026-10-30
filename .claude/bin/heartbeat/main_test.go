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
	lines, _ := check(logs, tasks, false, windows, now.Add(10*time.Minute))
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

	lines, _ := check(logs, tasks, false, windows, now.Add(time.Minute))
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
	lines, _ := check(logs, map[string]*task{}, false, map[string]bool{}, time.Now())
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
	if lines, _ := check(logs, map[string]*task{}, false, map[string]bool{}, time.Now()); len(lines) != 0 {
		t.Fatalf("got %v, want no lines", lines)
	}
}

// withPipeline replaces the autofix.sh process check for one test.
func withPipeline(t *testing.T, running bool) {
	t.Helper()
	old := pipelineRunning
	pipelineRunning = func(string) bool { return running }
	t.Cleanup(func() { pipelineRunning = old })
}

// stuckTask: a task left at aider's prompt for a minute (attempt task-s-fix1).
func stuckTask(t *testing.T) (lines []string, alert string) {
	notifyOn = false
	logs := t.TempDir()
	windows := map[string]bool{"task-s-fix1": true}
	tasks := map[string]*task{}
	now := time.Now()
	writeLog(t, logs, "task-s-fix1", "editing\n> \n")
	check(logs, tasks, false, windows, now)
	return check(logs, tasks, false, windows, now.Add(time.Minute))
}

func TestStuckWithPipelineAlerts(t *testing.T) {
	var asked string
	old := pipelineRunning
	pipelineRunning = func(base string) bool { asked = base; return true }
	t.Cleanup(func() { pipelineRunning = old })
	_, alert := stuckTask(t)
	if !strings.HasPrefix(alert, "ALERT task-s-fix1 STUCK: ") {
		t.Fatalf("got alert %q, want ALERT task-s-fix1 STUCK", alert)
	}
	if asked != "task-s" {
		t.Fatalf("pipeline checked for %q, want base name task-s", asked)
	}
}

func TestStuckWithoutPipelineDoesNotAlert(t *testing.T) {
	withPipeline(t, false)
	lines, alert := stuckTask(t)
	if alert != "" {
		t.Fatalf("got alert %q, want none", alert)
	}
	if len(lines) != 1 || state(t, lines[0]) != "STUCK" {
		t.Fatalf("got %v, want one STUCK line still printed", lines)
	}
}

func TestDeadWithPipelineAlerts(t *testing.T) {
	withPipeline(t, true)
	notifyOn = false
	logs := t.TempDir()
	writeLog(t, logs, "task-g", "running\n")
	if err := os.WriteFile(filepath.Join(logs, "task-g.pid"), []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, alert := check(logs, map[string]*task{}, false, map[string]bool{}, time.Now())
	if !strings.HasPrefix(alert, "ALERT task-g DEAD: ") {
		t.Fatalf("got alert %q, want ALERT task-g DEAD", alert)
	}
}

func TestWorkingNeverAlerts(t *testing.T) {
	withPipeline(t, true)
	notifyOn = false
	logs := t.TempDir()
	windows := map[string]bool{"task-h": true}
	tasks := map[string]*task{}
	now := time.Now()
	writeLog(t, logs, "task-h", "starting\n")
	check(logs, tasks, false, windows, now)
	writeLog(t, logs, "task-h", "starting\nediting\n")
	lines, alert := check(logs, tasks, true, windows, now.Add(time.Minute))
	if alert != "" || len(lines) != 1 || state(t, lines[0]) != "WORKING" {
		t.Fatalf("got %v alert %q, want one WORKING line and no alert", lines, alert)
	}
}

func TestBaseName(t *testing.T) {
	for in, want := range map[string]string{"loop-04": "loop-04", "loop-04-fix1": "loop-04", "a-fix12": "a", "fixer": "fixer"} {
		if got := baseName(in); got != want {
			t.Errorf("baseName(%q) = %q, want %q", in, got, want)
		}
	}
}

// An old run's log (8 minutes untouched) with a fresh .started file is a new attempt, not STUCK.
func TestOldLogNewAttemptIsNotStuck(t *testing.T) {
	notifyOn = false
	logs := t.TempDir()
	windows := map[string]bool{"task-n-fix1": true}
	now := time.Now()
	writeLog(t, logs, "task-n-fix1", "last run's output\n")
	old := now.Add(-8 * time.Minute)
	os.Chtimes(filepath.Join(logs, "task-n-fix1.log"), old, old)
	if err := os.WriteFile(filepath.Join(logs, "task-n-fix1.started"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, alert := check(logs, map[string]*task{}, false, windows, now)
	if len(lines) != 1 || state(t, lines[0]) == "STUCK" || alert != "" {
		t.Fatalf("got %q alert %q, want not STUCK", lines, alert)
	}
}
