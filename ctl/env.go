package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	namespace = "jobops"
	kubeCtx   = "docker-desktop"
	image     = "jobops:dev"
)

// The Deployments, in start order.
var deploys = []string{"queue", "api", "worker-laptop", "worker-mac", "gateway"}

func joinDeploys(sep string) string { return strings.Join(deploys, sep) }

// env: the repo root every path is relative to.
type env struct{ root string }

// newEnv finds the repo root: JOBOPS_REPO (set by bin/jobops), else git's top level.
func newEnv() (*env, error) {
	root := os.Getenv("JOBOPS_REPO")
	if root == "" {
		out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
		if err != nil {
			return nil, errors.New("run from inside the JobOps repo (or through bin/jobops)")
		}
		root = strings.TrimSpace(string(out))
	}
	if _, err := os.Stat(filepath.Join(root, "infra", "k8s", "kustomization.yaml")); err != nil {
		return nil, fmt.Errorf("%s is not the JobOps repo (no infra/k8s)", root)
	}
	return &env{root: root}, nil
}

func (e *env) path(p ...string) string { return filepath.Join(append([]string{e.root}, p...)...) }

// cmd builds a command that runs in the repo root.
func (e *env) cmd(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.Dir = e.root
	return c
}

// out runs a command and returns its stdout; on failure the error carries its stderr.
func (e *env) out(stdin []byte, name string, args ...string) ([]byte, error) {
	c := e.cmd(name, args...)
	if stdin != nil {
		c.Stdin = bytes.NewReader(stdin)
	}
	var stderr bytes.Buffer
	c.Stderr = &stderr
	b, err := c.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		return b, fmt.Errorf("%s %s: %v %s", name, strings.Join(args, " "), err, msg)
	}
	return b, nil
}

func (e *env) ok(name string, args ...string) bool { return e.cmd(name, args...).Run() == nil }

// kubectl args for the JobOps namespace on Docker Desktop's cluster.
func k(args ...string) []string {
	return append([]string{"--context", kubeCtx, "-n", namespace}, args...)
}

func (e *env) kubectl(stdin []byte, args ...string) ([]byte, error) {
	return e.out(stdin, "kubectl", k(args...)...)
}

func (e *env) needCluster() error {
	if !e.ok("kubectl", "--context", kubeCtx, "get", "nodes") {
		return errors.New("Kubernetes is not running. Docker Desktop > Settings > Kubernetes (kubeadm), then try again.")
	}
	return nil
}

// waitFor polls check every 2 s until it is true or the time is up.
func waitFor(d time.Duration, what string, check func() bool) error {
	end := time.Now().Add(d)
	for !check() {
		if time.Now().After(end) {
			return fmt.Errorf("%s did not come up within %s", what, d)
		}
		time.Sleep(2 * time.Second)
	}
	return nil
}

// answers: an HTTP GET that returns 2xx within 3 s.
func answers(url string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res.StatusCode/100 == 2
}

func okLine(format string, a ...any)   { fmt.Printf("[ok] "+format+"\n", a...) }
func warnLine(format string, a ...any) { fmt.Printf("[!!] "+format+"\n", a...) }
