package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Two ports on the Mac, bound to 127.0.0.1 only (infra/k8s/gateway.yaml says why: a
// LoadBalancer on Docker Desktop listens on every network, and the UI has no login).
var forwards = []struct {
	service string
	port    int
}{
	{"gateway", 8080}, // the web UI
	{"api", 3000},     // the Chrome extension
}

const forwardDaemon = "_forward"

func (e *env) pidFile() string { return e.path("data", "port-forward.pid") }

// forwardStart replaces any running supervisor with a new one, detached from this terminal
// (its own session), and waits until the UI answers.
func (e *env) forwardStart() error {
	e.forwardStop()
	if err := os.MkdirAll(e.path("data"), 0o755); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	logf, err := os.OpenFile(e.path("data", "port-forward.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()
	c := exec.Command(self, forwardDaemon)
	c.Dir = e.root
	c.Env = append(os.Environ(), "JOBOPS_REPO="+e.root)
	c.Stdout, c.Stderr = logf, logf
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := c.Start(); err != nil {
		return err
	}
	if err := os.WriteFile(e.pidFile(), []byte(strconv.Itoa(c.Process.Pid)+"\n"), 0o644); err != nil {
		return err
	}
	c.Process.Release()
	return waitFor(40*time.Second, "localhost:8080 (see data/port-forward.log)", func() bool {
		return answers("http://127.0.0.1:8080/health")
	})
}

// forwardStop ends the supervisor (it stops its kubectl children), and any port-forward left by
// the old shell version of bin/jobops.
func (e *env) forwardStop() {
	if b, err := os.ReadFile(e.pidFile()); err == nil {
		for _, f := range strings.Fields(string(b)) {
			if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
				syscall.Kill(pid, syscall.SIGTERM)
			}
		}
	}
	os.Remove(e.pidFile())
	exec.Command("pkill", "-f", "kubectl --context "+kubeCtx+" -n "+namespace+" port-forward").Run()
	time.Sleep(300 * time.Millisecond) // let the ports close before new listeners bind them
}

// superviseForwards runs each kubectl port-forward and starts it again when it exits (a
// port-forward ends when its pod is replaced). SIGTERM or SIGINT stops them all.
func (e *env) superviseForwards() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	log.SetFlags(log.LstdFlags)
	log.Printf("supervisor %d started", os.Getpid())
	var wg sync.WaitGroup
	for _, f := range forwards {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				c := exec.CommandContext(ctx, "kubectl", k("port-forward", "--address", "127.0.0.1",
					"svc/"+f.service, fmt.Sprintf("%d:%d", f.port, f.port))...)
				c.Stdout, c.Stderr = os.Stdout, os.Stderr
				err := c.Run()
				if ctx.Err() != nil {
					return
				}
				log.Printf("%s:%d ended (%v); again in 2 s", f.service, f.port, err)
				select {
				case <-ctx.Done():
				case <-time.After(2 * time.Second):
				}
			}
		}()
	}
	wg.Wait()
	log.Printf("supervisor %d stopped", os.Getpid())
	return nil
}
