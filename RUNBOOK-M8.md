# Milestone 8 runbook: JobOps on local Kubernetes

JobOps runs in Docker Desktop's built-in Kubernetes cluster. The API, the queue server, both
workers and the gateway (web UI) start on their own when Docker Desktop starts, and Kubernetes
restarts any of them that crashes. The models stay outside the cluster: general14 and embed on
the Mac (Metal GPU), general7 on the laptop.

One command does almost everything: `bin/jobops`. Run it without arguments for the list. It is
a Go program (`ctl/`, standard library only); `bin/jobops` builds it when its code changed and
runs it. Its background part keeps the two port-forwards alive: one supervisor process
(`ctl/.bin/jobops _forward`, its pid in `data/port-forward.pid`, its log in
`data/port-forward.log`) restarts a forward when its pod is replaced.

## Daily use

    bin/jobops status          # pods, restarts, whether the UI answers
    open http://localhost:8080 # the web UI (was 127.0.0.1:5173 with npm run ui)
    bin/jobops cli batch start --limit 3
    bin/jobops logs worker-laptop
    bin/jobops watch           # every service log in tmux, one window each

After a reboot, or any morning:

1. Laptop: double-click `C:\llama\start-server.cmd` (never an auto-start task).
2. Mac: `bin/jobops start`. It starts Docker Desktop and waits for Kubernetes, starts Qdrant,
   brings the pods back (one each), stops the coder model if no coder run is active, starts
   general14 and embed, checks the laptop model, opens localhost:8080 (UI) and localhost:3000
   (extension), and prints what the health bar shows. Each line says `[ok]` or `[!!]` with the
   fix. From cold it takes about a minute and a half.

After changing code: `bin/jobops up` (builds the image, applies the manifests, restarts the pods).

## Setup, once

1. Docker Desktop > Settings > Resources: memory 4 GB or more.
2. Docker Desktop > Settings > Kubernetes: enable it, cluster type **kubeadm** (not kind: kind
   cannot see the image built here or the `/Users` folders), Apply. Wait for "Kubernetes running".
3. Stop the local stack if it runs (`tmux kill-session -t jobops`): the cluster gets its own copy
   of the database, and two stacks would do the same work twice.
4. `bin/jobops db-import`: copies `data/jobops.db` into the cluster's data volume.
5. `bin/jobops up`.

From then on the database that counts is the one in the cluster; `data/jobops.db` on the Mac is
the old copy. `bin/jobops db-import --force` replaces the cluster copy with the Mac's (the cluster
copy is kept as `jobops.db.before-import` in the volume).

## Kubernetes in five minutes (in JobOps terms)

Docker runs one container from one image. Kubernetes runs many containers and keeps them in the
state you describe in YAML files ("one API, one queue, two workers, always"). You never start a
container yourself: you apply the files, and Kubernetes makes it so and keeps it so.

| Word | What it is | In JobOps |
|---|---|---|
| Cluster, node | The machine(s) Kubernetes runs on | Docker Desktop's VM: one node, `docker-desktop` |
| Image | The packaged program | `jobops:dev`, one image for every service (`Dockerfile`) |
| Pod | One running copy of a container (or a few that share a network) | `api-59f9...`; its name changes on every restart |
| Deployment | "Keep N pods of this running" | `api`, `queue`, `worker-laptop`, `worker-mac`, `gateway` (1 each) |
| Service | A fixed name and address in front of pods | `http://queue:8090`, `http://api:3000`: pods use these names |
| ConfigMap | Settings as environment variables | `jobops-cluster` (`infra/k8s/config.yaml`) |
| Secret | Settings that should not be in files | `jobops-env`, made from `.env` by `bin/jobops up`; never in git |
| PersistentVolumeClaim | Disk that survives pod restarts | `jobops-data`: the database and logs |
| hostPath | A folder of the node mounted into a pod | your `profile/`, so resume data stays on the Mac |
| Probe | A health check Kubernetes runs | readiness (send traffic?) and liveness (restart?) |
| Namespace | A folder for resources | `jobops` |
| Kustomize | Combines the YAML files into one apply | `infra/k8s/kustomization.yaml` |

How a crash is handled: the process exits, or its liveness probe stops answering, so the pod
fails; the Deployment sees one pod missing and starts a new one. Checked on 2026-11-04: deleting
the queue, a worker and the gateway brought new pods in seconds.

`kubectl` is the command-line tool that talks to the cluster. `bin/jobops` wraps the commands you
need; the raw ones, if you want to look around:

    kubectl -n jobops get pods                 # what runs
    kubectl -n jobops describe pod <name>      # why a pod does not start (Events at the end)
    kubectl -n jobops logs deploy/api          # a service's log
    kubectl -n jobops delete pod <name>        # "kill" one; the Deployment replaces it
    kubectl -n jobops get events --sort-by=.lastTimestamp

## How the pieces connect

    browser ──> 127.0.0.1:8080 ──port-forward──> gateway ──/api/*──> api:3000
    extension ─> 127.0.0.1:3000 ─port-forward──> api:3000
    api, workers ──> queue:8090           (Service names, inside the cluster)
    queue (fetch) ──> jd-search, Chromium ──> api:3000
    pods ──> host.docker.internal:8085 general14, :8082 embed, :6333 Qdrant (the Mac)
    pods ──> 10.10.10.1:8084 general7 (the laptop, key from .env)

- Every Service is ClusterIP (inside the cluster only). The UI has no login, so it must not be
  reachable from other machines. A LoadBalancer Service on Docker Desktop listens on all of the
  Mac's networks (the laptop link and Wi-Fi too), and pods cannot tell those callers from the Mac:
  every request arrives from Docker's internal router (checked). So `bin/jobops` runs
  `kubectl port-forward --address 127.0.0.1`, in a loop that reconnects when a pod is replaced.
- Inside a pod `127.0.0.1` is the pod itself; `host.docker.internal` is the Mac. Services bound to
  the Mac's 127.0.0.1 (llama.cpp) are reachable that way (checked).
- `infra/k8s/config.yaml` holds the values that differ in the cluster; it wins over `.env`.
- Qdrant stays in Docker Compose (`infra/qdrant/`), not in the cluster.

## Where the data is

- Database: the volume `jobops-data` (`/app/data/jobops.db` in every pod; also the model-call
  and report-feedback logs). Back it up with `bin/jobops db-backup` (to
  `data/backups/jobops-<time>.db`, git-ignored).
- **The volume is deleted with its claim**: never `kubectl delete namespace jobops`, `kubectl
  delete pvc jobops-data`, or Docker Desktop's "Reset Kubernetes cluster" without a db-backup first.
  `bin/jobops down` only scales the pods to zero and keeps the volume.
- `profile/` stays on the Mac and is mounted into the pods; PDFs and reports written by the pods
  appear there.
- No private data is in the image (`.dockerignore` is an allow-list): no `profile/`, `data/`,
  `.env`, `.scout/`.

## Differences from running locally

- The careers crawler uses Debian's Chromium in the image (Google Chrome has no Linux arm64 build).
- The OpenResume parse-back reader (AGPL, `.scout/`, git-ignored) is not in the image; it is
  mounted (next section).
- The health bar sees workers through the queue (each leases or pings every 15 s), not `pgrep`.
- The local way still works (`RUNBOOK-M5.md`, `.claude/bin/batch-up.sh`, `npm run ui`) but uses
  `data/jobops.db` on the Mac: run one or the other, never both.

## OpenResume runner

The third parse-back reader. Every render needs pdftotext, pdf.js and OpenResume; a missing one
fails the render with `reader_missing` (tests set `JOBOPS_PARSE_READERS=pdftotext,pdfjs`).

- It lives in `.scout/openresume-runner` (AGPL, git-ignored, never in the image) and is mounted
  read-only at `/app/.scout/openresume-runner` in the api and both worker pods. If the folder is
  missing, Kubernetes creates it empty: the pods start, every render fails with `reader_missing`.
- It runs as `node dist/parse.mjs <pdf>` (a bundle; pdfjs-dist comes from its `node_modules`).
- After changing the runner, rebuild the bundle (from that folder):
  `./node_modules/.bin/esbuild parse.ts --bundle --platform=node --format=esm --target=node24 --external:pdfjs-dist --outfile=dist/parse.mjs`
- Check: `node api/src/cli.ts ats check` lists three readers; `ats recheck` re-reads the PDFs
  already in `profile/pdf` (read-only).

## Troubleshooting

| Symptom | Check |
|---|---|
| `bin/jobops`: "Kubernetes is not running" | Docker Desktop started? Settings > Kubernetes green? |
| localhost:8080 does not answer | `bin/jobops ui`; then `data/port-forward.log` |
| A pod is `CrashLoopBackOff` | `bin/jobops logs <name>`; `kubectl -n jobops describe pod <pod>` |
| A worker pod is `Init:0/1` | it waits for the queue: `bin/jobops logs queue` |
| Health bar: general14 or embed down | start them on the Mac with `.claude/bin/llm.sh` |
| Health bar: general7 down | laptop: `C:\llama\start-server.cmd`; `curl 10.10.10.1:8084/health` |
| Port 3000 or 8080 "address already in use" | the local stack is running: stop it |
| Docker Desktop VM "stopped unexpectedly" | Quit and reopen Docker Desktop. Never "Reset to factory defaults" (it deletes the images and the cluster's volumes) |

## CI

`.github/workflows/ci.yml` runs on every push and pull request: API and UI typecheck, the UI
build, all TypeScript tests (with typst and poppler, so the render tests run), `gofmt`, `go vet`
and `go test` for `queue`, `jd-search` and `gateway`, the kustomize render, and a Docker build
(not pushed). Nothing is deployed from CI.

## Later

- PostgreSQL in the cluster in place of SQLite (user, 2026-11-04: SQLite now, Postgres later).
- Opening the two port-forwards at login (a launchd agent), if the user wants it.
