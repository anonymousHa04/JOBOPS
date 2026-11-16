// heartbeat watches running coder tasks and says whether each one is working,
// idle, stuck, or dead. It only reads: it never stops or restarts anything.
//
// A task is running when .agent-logs/<task>.log exists and <task>.done does not
// (run-coder.sh and run-mini.sh delete .done at start and touch it at the end).
// Signals per task: log growth, the llama.cpp server's busy slots, an aider
// prompt waiting for input at the end of the log, and whether the process (pid
// file) or its tmux window is still there.
//
// Usage (from the repo root):
//
//	go run -C .claude/bin/heartbeat . [-interval 15s] [-port 8081] [-once] [-notify=false] [-until-alert]
//
// With -until-alert it exits with code 3 the first time a task is STUCK or DEAD
// while its autofix.sh pipeline still runs, after printing one line:
// "ALERT <attempt> <STATE>: <reason>". A STUCK or DEAD task whose autofix.sh is
// gone (a run the manager stopped) is printed but does not alert.
// .claude/bin/watch-coders.sh wraps this mode for the manager.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	idleAfter  = 2 * time.Minute
	stuckAfter = 5 * time.Minute
	promptWait = 30 * time.Second // a prompt this old is not a passing frame
)

// task is what the watcher remembers between checks.
type task struct {
	size       int64
	lastActive time.Time
	state      string
}

// observation is one check of one task.
type observation struct {
	alive    bool
	grew     bool
	busy     bool
	waiting  bool
	sinceAct time.Duration
}

// classify turns one observation into a state and a short reason.
func classify(o observation) (string, string) {
	switch {
	case !o.alive:
		return "DEAD", "process and tmux window gone, no .done file"
	case o.waiting && o.sinceAct >= promptWait:
		return "STUCK", fmt.Sprintf("aider waiting at \">\" prompt, %s idle", round(o.sinceAct))
	case o.sinceAct >= stuckAfter:
		return "STUCK", fmt.Sprintf("no log output and model idle for %s", round(o.sinceAct))
	case o.sinceAct >= idleAfter:
		return "IDLE", fmt.Sprintf("no log output and model idle for %s", round(o.sinceAct))
	case o.busy:
		return "WORKING", "model busy"
	default:
		return "WORKING", "log growing"
	}
}

func round(d time.Duration) time.Duration { return d.Round(time.Second) }

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// waitingAtPrompt reports whether the log ends with aider's empty input prompt.
func waitingAtPrompt(logPath string) bool {
	f, err := os.Open(logPath)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	off := st.Size() - 2048
	if off < 0 {
		off = 0
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil {
		return false
	}
	lines := strings.Split(ansi.ReplaceAllString(string(buf), ""), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l == ">"
		}
	}
	return false
}

// alive: the pid in <task>.pid still runs, or, without a pid file, the task's
// tmux window still exists (aider runs write no pid file).
func alive(logs, name string, windows map[string]bool) bool {
	if b, err := os.ReadFile(filepath.Join(logs, name+".pid")); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			err := syscall.Kill(pid, 0)
			if err == nil || errors.Is(err, syscall.EPERM) {
				return true
			}
		}
	}
	return windows[name]
}

func tmuxWindows() map[string]bool {
	out, err := exec.Command("tmux", "list-windows", "-t", "jobops", "-F", "#W").Output()
	w := map[string]bool{}
	if err != nil {
		return w
	}
	for _, n := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		w[n] = true
	}
	return w
}

// modelBusy: any llama.cpp slot is generating. An unreachable server counts as not busy.
func modelBusy(port int) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/slots", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var slots []struct {
		IsProcessing bool `json:"is_processing"`
	}
	if json.NewDecoder(resp.Body).Decode(&slots) != nil {
		return false
	}
	for _, s := range slots {
		if s.IsProcessing {
			return true
		}
	}
	return false
}

// recent: a task that ended without a .done file is reported as DEAD only if
// its log was written this recently; older ones are long-finished manual runs.
const recent = 30 * time.Minute

// running lists coder tasks (they have a .context.status file; server logs and
// manual runs do not) with no .done file, that are still alive or ended recently.
func running(logs string, windows map[string]bool, now time.Time) []string {
	matches, _ := filepath.Glob(filepath.Join(logs, "*.log"))
	var names []string
	for _, m := range matches {
		name := strings.TrimSuffix(filepath.Base(m), ".log")
		if strings.Contains(name, ".") { // .check.log, .llm.log and the like
			continue
		}
		if _, err := os.Stat(filepath.Join(logs, name+".context.status")); err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(logs, name+".done")); err == nil {
			continue
		}
		st, err := os.Stat(m)
		if err != nil || (!alive(logs, name, windows) && now.Sub(st.ModTime()) > recent) {
			continue
		}
		names = append(names, name)
	}
	return names
}

var fixSuffix = regexp.MustCompile(`-fix[0-9]+$`)

// baseName: the task an attempt belongs to (<task>-fixN -> <task>).
func baseName(attempt string) string { return fixSuffix.ReplaceAllString(attempt, "") }

// pipelineRunning reports whether an autofix.sh process for the task exists.
// A variable so tests can replace it.
var pipelineRunning = func(base string) bool {
	pat := `autofix\.sh ` + regexp.QuoteMeta(base) + `( |$)`
	return exec.Command("pgrep", "-f", pat).Run() == nil
}

// check looks at every running task once and returns one line per task, plus
// an alert line for the first STUCK or DEAD task whose pipeline still runs.
func check(logs string, tasks map[string]*task, busy bool, windows map[string]bool, now time.Time) ([]string, string) {
	var out []string
	alert := ""
	for _, name := range running(logs, windows, now) {
		logPath := filepath.Join(logs, name+".log")
		st, err := os.Stat(logPath)
		if err != nil {
			continue
		}
		t, seen := tasks[name]
		if !seen {
			t = &task{size: st.Size(), lastActive: now}
			tasks[name] = t
		}
		o := observation{alive: alive(logs, name, windows), busy: busy, grew: st.Size() > t.size}
		if o.grew || o.busy {
			t.lastActive = now
		}
		if !seen {
			// First sight: date activity from the log's own write time, or from the attempt's
			// .started file when newer. Until aider writes, <attempt>.log can be an old run's log,
			// and a new attempt was called STUCK seconds after it started (2026-10-30).
			t.lastActive = st.ModTime()
			if s, err := os.Stat(filepath.Join(logs, name+".started")); err == nil && s.ModTime().After(t.lastActive) {
				t.lastActive = s.ModTime()
			}
			if busy {
				t.lastActive = now
			}
		}
		t.size = st.Size()
		o.sinceAct = now.Sub(t.lastActive)
		o.waiting = waitingAtPrompt(logPath)
		state, why := classify(o)
		if (state == "STUCK" || state == "DEAD") && t.state != state {
			notify(name, state, why)
		}
		t.state = state
		out = append(out, fmt.Sprintf("%s %-28s %-7s  %s", now.Format("15:04:05"), name, state, why))
		if alert == "" && (state == "STUCK" || state == "DEAD") && pipelineRunning(baseName(name)) {
			alert = fmt.Sprintf("ALERT %s %s: %s", name, state, why)
		}
	}
	return out, alert
}

var notifyOn = true

func notify(name, state, why string) {
	if !notifyOn {
		return
	}
	msg := strings.ReplaceAll(fmt.Sprintf("%s: %s", name, why), `"`, `'`)
	_ = exec.Command("osascript", "-e",
		fmt.Sprintf(`display notification "%s" with title "JobOps coder %s"`, msg, state)).Run()
}

func repoRoot() string {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	return strings.TrimSpace(string(out))
}

func main() {
	interval := flag.Duration("interval", 15*time.Second, "time between checks")
	port := flag.Int("port", 8081, "llama.cpp coder server port")
	once := flag.Bool("once", false, "check once and exit")
	root := flag.String("root", "", "repo root (default: git top level)")
	untilAlert := flag.Bool("until-alert", false, "exit 3 when a task is STUCK or DEAD and its autofix.sh still runs")
	flag.BoolVar(&notifyOn, "notify", true, "macOS notification when a task becomes STUCK or DEAD")
	flag.Parse()
	if *root == "" {
		*root = repoRoot()
	}
	logs := filepath.Join(*root, ".agent-logs")
	tasks := map[string]*task{}
	for {
		lines, alert := check(logs, tasks, modelBusy(*port), tmuxWindows(), time.Now())
		if len(lines) == 0 {
			fmt.Println(time.Now().Format("15:04:05"), "no coder task running")
		}
		for _, l := range lines {
			fmt.Println(l)
		}
		if *untilAlert && alert != "" {
			fmt.Println(alert)
			os.Exit(3)
		}
		if *once {
			return
		}
		time.Sleep(*interval)
	}
}
