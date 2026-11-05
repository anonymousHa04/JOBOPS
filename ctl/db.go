package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A short-lived pod that mounts the data volume, for copying the database in and out.
const helperPod = `apiVersion: v1
kind: Pod
metadata: { name: jobops-db }
spec:
  restartPolicy: Never
  containers:
    - name: db
      image: ` + image + `
      imagePullPolicy: Never
      command: [sleep, "3600"]
      volumeMounts: [{ name: data, mountPath: /app/data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: jobops-data }
`

func (e *env) helperUp() error {
	e.kubectl(nil, "delete", "pod", "jobops-db", "--ignore-not-found", "--wait=true")
	if _, err := e.kubectl([]byte(helperPod), "apply", "-f", "-"); err != nil {
		return err
	}
	_, err := e.kubectl(nil, "wait", "pod/jobops-db", "--for=condition=Ready", "--timeout=90s")
	return err
}

func (e *env) helperDown() {
	e.kubectl(nil, "delete", "pod", "jobops-db", "--ignore-not-found", "--wait=false")
}

// inPod runs a shell command in the helper pod and returns its trimmed output.
func (e *env) inPod(script string) (string, error) {
	b, err := e.kubectl(nil, "exec", "jobops-db", "--", "sh", "-c", script)
	return strings.TrimSpace(string(b)), err
}

// dbImport copies data/jobops.db into the cluster volume. A cluster database that already has
// jobs is replaced only with force (kept as jobops.db.before-import); then the pods are stopped
// for the copy, and bin/jobops start brings them back.
func (e *env) dbImport(force bool) error {
	if err := e.needCluster(); err != nil {
		return err
	}
	if _, err := os.Stat(e.path("data", "jobops.db")); err != nil {
		return errors.New("no data/jobops.db to import")
	}
	if _, err := e.out(nil, "kubectl", "--context", kubeCtx, "apply", "-f", "infra/k8s/namespace.yaml"); err != nil {
		return err
	}
	if _, err := e.kubectl(nil, "apply", "-f", "infra/k8s/storage.yaml"); err != nil { // only the volume
		return err
	}
	if err := e.helperUp(); err != nil {
		return err
	}
	defer e.helperDown()
	// Checked before anything stops: a refused import leaves JobOps running.
	jobs, _ := e.inPod(`test -f /app/data/jobops.db && sqlite3 /app/data/jobops.db "SELECT count(*) FROM jobs" 2>/dev/null || echo 0`)
	if jobs != "" && jobs != "0" && !force {
		return fmt.Errorf("the cluster database already has %s jobs; run bin/jobops db-import --force to replace it (it is kept as jobops.db.before-import)", jobs)
	}
	e.forwardStop()
	for _, d := range deploys {
		e.kubectl(nil, "scale", "deploy/"+d, "--replicas=0")
	}
	e.kubectl(nil, "wait", "pod", "-l", "app in (queue,api,worker-laptop,worker-mac)", "--for=delete", "--timeout=320s")
	tmp, err := os.MkdirTemp("", "jobops-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	copyPath := filepath.Join(tmp, "jobops.db")
	// .backup gives a consistent copy, even while a local API still has the file open.
	if _, err := e.out(nil, "sqlite3", "data/jobops.db", ".backup '"+copyPath+"'"); err != nil {
		return err
	}
	if _, err := e.inPod(`cd /app/data && { [ -f jobops.db ] && mv jobops.db jobops.db.before-import || true; } && rm -f jobops.db-wal jobops.db-shm`); err != nil {
		return err
	}
	if _, err := e.kubectl(nil, "cp", copyPath, "jobops-db:/app/data/jobops.db"); err != nil {
		return err
	}
	n, err := e.inPod(`sqlite3 /app/data/jobops.db "SELECT count(*) FROM jobs"`)
	if err != nil {
		return err
	}
	okLine("imported data/jobops.db (%s jobs). Stop the local API, queue and workers now: from here", n)
	fmt.Println("     the cluster has its own copy. Then: bin/jobops start")
	return nil
}

// dbBackup copies the cluster database to data/backups/jobops-<time>.db (git-ignored).
func (e *env) dbBackup() error {
	if err := e.needCluster(); err != nil {
		return err
	}
	if err := os.MkdirAll(e.path("data", "backups"), 0o755); err != nil {
		return err
	}
	out := filepath.Join("data", "backups", "jobops-"+time.Now().Format("20060102-150405")+".db")
	if err := e.helperUp(); err != nil {
		return err
	}
	defer e.helperDown()
	if _, err := e.inPod(`sqlite3 /app/data/jobops.db ".backup /app/data/backup.db"`); err != nil {
		return err
	}
	if _, err := e.kubectl(nil, "cp", "jobops-db:/app/data/backup.db", out); err != nil {
		return err
	}
	e.inPod("rm -f /app/data/backup.db")
	okLine("%s", out)
	return nil
}
