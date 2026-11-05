package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const llm = ".claude/bin/llm.sh"

// start: everything for a normal day. Never rebuilds (that is up) and never starts the laptop
// model (the user starts it by hand there; it is only checked).
func (e *env) start() error {
	// 1. Docker Desktop, then its Kubernetes (the JobOps pods come back with it).
	if !e.ok("docker", "info") {
		fmt.Println("starting Docker Desktop...")
		if !e.ok("docker", "desktop", "start") {
			e.ok("open", "-a", "Docker")
		}
		if err := waitFor(4*time.Minute, "Docker", func() bool { return e.ok("docker", "info") }); err != nil {
			return err
		}
	}
	okLine("Docker")
	if err := waitFor(5*time.Minute, "Kubernetes", func() bool { return e.ok("kubectl", "--context", kubeCtx, "get", "nodes") }); err != nil {
		return err
	}
	okLine("Kubernetes")

	// 2. Qdrant (Docker Compose, outside the cluster).
	if _, err := e.out(nil, "docker", "compose", "-f", "infra/qdrant/docker-compose.yml", "up", "-d"); err != nil {
		warnLine("Qdrant did not start: docker compose -f infra/qdrant/docker-compose.yml up -d")
	} else {
		okLine("Qdrant")
	}

	// 3. The pods: one each again after a down.
	if _, err := e.kubectl(nil, "get", "deploy", "api"); err != nil {
		return fmt.Errorf("JobOps is not deployed yet: run bin/jobops up")
	}
	if err := e.scale(1); err != nil {
		return err
	}
	if err := e.waitRollouts(false); err != nil {
		return err
	}
	okLine("pods: %s", joinDeploys(" "))

	// 4. Mac models. general14 needs the coder model stopped (16 GB); never while a coder runs.
	e.macModels()

	// 5. The laptop model: only checked.
	if answers("http://10.10.10.1:8084/health") {
		okLine("general7 (laptop)")
	} else {
		warnLine(`general7 (laptop) is down: on the laptop double-click C:\llama\start-server.cmd`)
	}

	// 6. The UI and the extension's port, then what the health bar shows.
	if err := e.forwardStart(); err != nil {
		return err
	}
	okLine("UI http://localhost:8080 and extension port localhost:3000")
	fmt.Println(healthSummary())
	return nil
}

func (e *env) macModels() {
	status, _ := e.out(nil, llm, "status")
	if coderUp(string(status)) {
		if e.ok("pgrep", "-f", "aider|run-coder.sh|run-patch.sh|autofix.sh") {
			warnLine("a coder run is in progress: general14 not started (run bin/jobops start again after it ends)")
			return
		}
		if _, err := e.out(nil, llm, "stop", "coder"); err == nil {
			okLine("coder model stopped (general14 needs the memory)")
		}
	}
	for _, m := range []string{"general14", "embed"} {
		if _, err := e.out(nil, llm, "start", m); err != nil {
			warnLine("%s did not start: %s start %s", m, llm, m)
		} else {
			okLine("%s (Mac)", m)
		}
	}
}

// coderUp reads llm.sh status: a line "coder  :8081  healthy ...".
func coderUp(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && f[0] == "coder" && f[2] == "healthy" {
			return true
		}
	}
	return false
}

// healthSummary: the UI health bar's view, in one line.
func healthSummary() string {
	c := http.Client{Timeout: 15 * time.Second}
	res, err := c.Get("http://127.0.0.1:8080/api/ui/health")
	if err != nil {
		return "health bar: no answer yet; open the UI in a minute"
	}
	defer res.Body.Close()
	var h struct {
		Services []struct {
			Name string `json:"name"`
			Up   *bool  `json:"up"`
		} `json:"services"`
	}
	if json.NewDecoder(res.Body).Decode(&h) != nil {
		return "health bar: no answer yet; open the UI in a minute"
	}
	return summarize(h.Services)
}

func summarize(services []struct {
	Name string `json:"name"`
	Up   *bool  `json:"up"`
}) string {
	var down []string
	for _, s := range services {
		if s.Up != nil && !*s.Up {
			down = append(down, s.Name)
		}
	}
	if len(down) == 0 {
		return "health bar: all green"
	}
	return "health bar: down: " + strings.Join(down, ", ")
}

func (e *env) scale(n int) error {
	for _, d := range deploys {
		if _, err := e.kubectl(nil, "scale", "deploy/"+d, fmt.Sprintf("--replicas=%d", n)); err != nil {
			return err
		}
	}
	return nil
}

func (e *env) waitRollouts(each bool) error {
	for _, d := range deploys {
		if _, err := e.kubectl(nil, "rollout", "status", "deploy/"+d, "--timeout=180s"); err != nil {
			return fmt.Errorf("%s did not start: bin/jobops logs %s", d, d)
		}
		if each {
			okLine("%s", d)
		}
	}
	return nil
}

// up: build the image, load .env, apply the manifests, restart the pods on the new image.
func (e *env) up() error {
	if err := e.needCluster(); err != nil {
		return err
	}
	fmt.Printf("building %s (first build takes a few minutes)...\n", image)
	if _, err := e.out(nil, "docker", "build", "-q", "-t", image, "."); err != nil {
		return err
	}
	okLine("image %s", image)
	if _, err := e.out(nil, "kubectl", "--context", kubeCtx, "apply", "-f", "infra/k8s/namespace.yaml"); err != nil {
		return err
	}
	if err := e.secret(); err != nil {
		return err
	}
	if err := e.apply(); err != nil {
		return err
	}
	okLine("manifests applied")
	for _, d := range deploys { // same tag, new image: restart to pick it up
		if _, err := e.kubectl(nil, "rollout", "restart", "deploy/"+d); err != nil {
			return err
		}
	}
	if err := e.waitRollouts(true); err != nil {
		return err
	}
	if err := e.forwardStart(); err != nil {
		return err
	}
	fmt.Println("UI: http://localhost:8080")
	return nil
}

func (e *env) down() error {
	if err := e.needCluster(); err != nil {
		return err
	}
	e.forwardStop()
	for _, d := range deploys {
		e.kubectl(nil, "scale", "deploy/"+d, "--replicas=0") // a missing one is fine
	}
	fmt.Println("stopped (database kept; bin/jobops start or up starts everything again)")
	return nil
}

func (e *env) ui() error {
	if err := e.needCluster(); err != nil {
		return err
	}
	if err := e.forwardStart(); err != nil {
		return err
	}
	fmt.Println("UI: http://localhost:8080")
	return nil
}

func (e *env) status() error {
	if err := e.needCluster(); err != nil {
		return err
	}
	b, err := e.kubectl(nil, "get", "pods", "-o", "wide")
	os.Stdout.Write(b)
	if err != nil {
		return err
	}
	if answers("http://127.0.0.1:8080/health") {
		fmt.Println("UI http://localhost:8080: 200")
	} else {
		fmt.Println("UI http://localhost:8080: not answering (bin/jobops ui)")
	}
	return nil
}

// logs and cli hand the terminal to kubectl (Ctrl-C, colors and prompts work as usual).
func (e *env) logs(name string) error {
	known := false
	for _, d := range deploys {
		known = known || d == name
	}
	if !known {
		return fmt.Errorf("unknown service %q: use %s", name, joinDeploys(", "))
	}
	return execKubectl(k("logs", "-f", "--tail=100", "deploy/"+name)...)
}

func (e *env) cli(args []string) error {
	tty := "-i"
	if isTerminal() {
		tty = "-it"
	}
	return execKubectl(k(append([]string{"exec", tty, "deploy/api", "--", "node", "api/src/cli.ts"}, args...)...)...)
}

// isTerminal: stdin and stdout are a terminal (the shell's own test, so /dev/null and pipes are not).
func isTerminal() bool {
	c := exec.Command("sh", "-c", "[ -t 0 ] && [ -t 1 ]")
	c.Stdin, c.Stdout = os.Stdin, os.Stdout
	return c.Run() == nil
}

func execKubectl(args ...string) error {
	bin, err := exec.LookPath("kubectl")
	if err != nil {
		return err
	}
	return syscall.Exec(bin, append([]string{"kubectl"}, args...), os.Environ())
}

// apply: the manifests with this repo's path in place of __REPO__ (hostPath needs it).
func (e *env) apply() error {
	m, err := e.out(nil, "kubectl", "kustomize", "infra/k8s")
	if err != nil {
		return err
	}
	_, err = e.out(render(m, e.root), "kubectl", "--context", kubeCtx, "apply", "-f", "-")
	return err
}

func render(manifests []byte, root string) []byte {
	return bytes.ReplaceAll(manifests, []byte("__REPO__"), []byte(root))
}

// secret: .env becomes the Secret jobops-env (never written to a file).
func (e *env) secret() error {
	if _, err := os.Stat(e.path(".env")); err != nil {
		fmt.Println("no .env: pods use the defaults and infra/k8s/config.yaml")
		return nil
	}
	y, err := e.kubectl(nil, "create", "secret", "generic", "jobops-env", "--from-env-file=.env", "--dry-run=client", "-o", "yaml")
	if err != nil {
		return err
	}
	if _, err := e.out(y, "kubectl", "--context", kubeCtx, "apply", "-f", "-"); err != nil {
		return err
	}
	okLine("Secret jobops-env from .env")
	return nil
}
