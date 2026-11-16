// Command jobops runs JobOps in local Kubernetes (Docker Desktop, kubeadm): it starts and stops
// everything, deploys new code, opens the UI, and copies the database in and out. bin/jobops
// builds and runs it. RUNBOOK-M8.md explains each step.
package main

import (
	"fmt"
	"os"
)

const usage = `JobOps in local Kubernetes (Docker Desktop, kubeadm). RUNBOOK-M8.md explains each step.

  bin/jobops start         everything for a normal day: Docker, Kubernetes, Qdrant, the pods,
                           the Mac models (general14, embed), localhost:8080; checks the laptop;
                           opens the UI in the browser
  bin/jobops up            build the image, load .env as a Secret, apply infra/k8s, wait
  bin/jobops down          stop every pod (scale to 0); the database volume is kept
  bin/jobops ui            (re)open localhost:8080 (UI) and :3000 (extension); up does it too
  bin/jobops status        pods, restarts, and whether the UI answers
  bin/jobops logs <name>   follow one service's log: api, queue, worker-laptop, worker-mac, gateway
  bin/jobops watch         every service's log in tmux, one window each (session jobops-logs)
  bin/jobops cli <args>    run the JobOps CLI inside the cluster, e.g. bin/jobops cli batch status
  bin/jobops db-import [--force]   copy data/jobops.db into the cluster volume (once)
  bin/jobops db-backup     copy the cluster database to data/backups/jobops-<time>.db

The models are not in the cluster: start (or .claude/bin/llm.sh) runs general14 and embed on
the Mac; general7 on the laptop is always started by hand (C:\llama\start-server.cmd).
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fmt.Print(usage)
		return
	}
	if err := run(args[0], args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jobops:", err)
		os.Exit(1)
	}
}

func run(cmd string, rest []string) error {
	e, err := newEnv()
	if err != nil {
		return err
	}
	switch cmd {
	case "start":
		return e.start()
	case "up":
		return e.up()
	case "down":
		return e.down()
	case "ui":
		return e.ui()
	case "status":
		return e.status()
	case "logs":
		if len(rest) == 0 {
			return fmt.Errorf("usage: bin/jobops logs <%s>", joinDeploys("|"))
		}
		return e.logs(rest[0])
	case "watch":
		return e.watch()
	case "cli":
		return e.cli(rest)
	case "db-import":
		return e.dbImport(len(rest) > 0 && rest[0] == "--force")
	case "db-backup":
		return e.dbBackup()
	case forwardDaemon: // internal: the port-forward supervisor (started by ui, start and up)
		return e.superviseForwards()
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	}
	fmt.Fprint(os.Stderr, usage)
	return fmt.Errorf("unknown command %q", cmd)
}
