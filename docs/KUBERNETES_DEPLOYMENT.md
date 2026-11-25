# GI on Kubernetes with Azure DevOps

How to run GI on the company Kubernetes cluster, built and deployed by an Azure DevOps pipeline, with the company's on-premise MariaDB. For a single Docker host instead, see [DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md).

| File | What it is |
|---|---|
| `Dockerfile` (repository root) | Builds the one GI image: a Python base image + `requirements.txt` + the app (web page, API, issue import) |
| `requirements.txt` (repository root) | The Python packages installed into the image |
| `deploy/k8s/configmap.yaml` | Non-secret settings (database host, `ISSUE_SOURCE`, time zones, …) |
| `deploy/k8s/secret.example.yaml` | Shape of the Secret `gi-secrets`. An example only: the pipeline creates the real one. |
| `deploy/k8s/deployment.yaml` | 2 replicas, rolling updates without downtime, health checks, hardened security |
| `deploy/k8s/service.yaml`, `ingress.yaml`, `pdb.yaml` | Internal service, site address, keep ≥ 1 replica during maintenance |
| `deploy/azure-pipelines.yml` | Example pipeline: build and push the image, create the Secret, deploy |

---

## 1. How the database password reaches the app

```
 Azure DevOps Library                 Pipeline (deploy stage)               Kubernetes                    GI pod
 variable group "gi-test"     ──▶     KubernetesManifest createSecret ──▶   Secret "gi-secrets"    ──▶    env MARIADB_PASSWORD
 GI_DB_PASSWORD  (secret 🔒)          (value masked in logs)                MARIADB_PASSWORD             (read at start-up)
 optionally linked to Azure Key Vault
```

- **The password is stored in one place:** a secret variable in Azure DevOps, or in Azure Key Vault linked to the variable group.
- **The pipeline copies it into the Kubernetes Secret on every deployment;** Azure DevOps masks it in the logs.
- **The pod receives it as the environment variable `MARIADB_PASSWORD`.** The other database settings (host, user, database name) are ordinary settings in the ConfigMap.
- **The password is never in git, the Dockerfile, the image, the ConfigMap or the manifests.**

To change the password: update `GI_DB_PASSWORD` in the Library and run the pipeline again; its deploy restarts the pods. Or update the Secret by hand and run `kubectl -n gi-test rollout restart deployment/gi`.

## 2. Several replicas, one importer

The Deployment runs **2 replicas**. Both serve the web page and the API, so the site stays up when a pod or node goes down, and updates roll out one pod at a time (`maxUnavailable: 0`).

Jobs that must run only once at a time are coordinated through MariaDB locks:

| Job | How |
|---|---|
| Issue import (every 5 min) and the daily sweep | Each run takes the `import` lock in MariaDB. Only the replica that gets it imports; the others skip that run. If that replica dies, the lock is freed and another takes the next run. |
| "Run import now" in Settings | Takes the same lock; if an import is already running, it says to try again in a minute. |
| Database migrations at start-up | Run under a `migrate` lock: replicas starting together wait for each other. |

With mock data, every replica generates the mock Oracle rows in memory, and the generator produces identical rows for any given day, so it does not matter which replica imports.

Health checks:
- **Readiness** (`/api/health`) fails while a pod cannot reach the database, so Kubernetes stops sending it traffic. The response says why, e.g. `{"ok":false,"error":"starting: database not reachable or not set up (… Can't connect to MySQL server …)"}`.
- **The web server starts first.** If MariaDB cannot be reached at start-up, the pod stays up (no restart loop), logs `database not reachable or not set up (…); retrying in N s` (5 s, then up to every 60 s), and sets up the database by itself once it can connect.
- **Liveness** (`/healthz`) only checks the process, so a database outage does not restart pods.
- On `SIGTERM` (rolling update, node drain) the app finishes requests in flight and exits cleanly.

## 3. Before the first deployment

### 3.1 On the on-premise MariaDB server (with the DBA)
```sql
CREATE DATABASE gi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'gi'@'<cluster egress subnet, e.g. 10.20.%>' IDENTIFIED BY '<password>';
GRANT ALL ON gi.* TO 'gi'@'<same>';
```
- MariaDB 10.11 or newer (11.4 LTS recommended).
- GI creates and updates its own tables on start-up, so the `gi` user needs full rights on the `gi` database only.

### 3.2 Network
- [ ] Pods can reach the MariaDB server on port 3306 (firewall rule from the cluster's egress addresses).
- [ ] Users' phones and laptops can reach the Ingress host name (internal network only).
- [ ] The build agent can pull the Python base image and reach PyPI, or a company PyPI mirror (§6).

### 3.3 Azure DevOps
- [ ] **Docker registry service connection** to the company registry (e.g. `company-registry`).
- [ ] **Kubernetes service connection** to the test cluster/namespace (e.g. `company-k8s-test`).
- [ ] **Namespace** `gi-test` exists (or ask the platform team to create it).
- [ ] **Variable group** `gi-test` (Pipelines › Library) with the variables `GI_DB_PASSWORD` and `GI_ADMIN_PASSCODE`, both marked secret (🔒). `GI_ADMIN_PASSCODE` is the passcode for switching to the Admin user in Settings › This device; without it, Admin cannot be chosen. To use Azure Key Vault: link the group to the vault and add the secret there. Key Vault names cannot contain `_`, so name it `GI-DB-PASSWORD` and use `$(GI-DB-PASSWORD)` in the pipeline.
- [ ] Allow the pipeline to use the variable group and the service connections (first run asks).
- [ ] Optional: **Environment** `gi-test` (Pipelines › Environments) with an approval check.

### 3.4 Fill in the placeholders
| File | Change |
|---|---|
| `deploy/k8s/configmap.yaml` | `MARIADB_HOST`, and `MARIADB_USER` / `MARIADB_DATABASE` if different |
| `deploy/k8s/deployment.yaml` | `image:` → `<your registry>/<repository>:latest` (the pipeline replaces the tag) |
| `deploy/k8s/ingress.yaml` | `ingressClassName`, `host`, TLS if available |
| `deploy/azure-pipelines.yml` | Service connection names, registry host, repository, namespace, agent pool, and `pythonImage` (the company's Python base image) |

If your company already has a pipeline template, copy the two `KubernetesManifest@1` steps (create the Secret, deploy) into it; they are the important part.

## 4. Deploy

1. Commit the filled-in files to the branch your pipeline builds.
2. Run the pipeline. **Build** pushes `<registry>/cleanroom/gi:<build id>`. **Deploy** creates `gi-secrets`, then applies the manifests with that image.
3. Check:
   ```bash
   kubectl -n gi-test get pods                       # 2 × gi-… Running, READY 1/1
   kubectl -n gi-test logs deploy/gi --tail=50       # migrations, then "import: … new rows" on one replica
   kubectl -n gi-test port-forward svc/gi 8080:80    # then open http://localhost:8080
   ```
4. Open the Ingress address and work through the checks in [DEPLOYMENT_SOP.md §7](./DEPLOYMENT_SOP.md) (switch users, post a delivery, look at Settings › Import).

First-time setup in the app (starting counts) is the same as on Docker: [DEPLOYMENT_SOP.md §8.1](./DEPLOYMENT_SOP.md).

**Loading the demo history** (erases the GI database first):
```bash
kubectl -n gi-test scale deploy/gi --replicas=0
kubectl -n gi-test run gi-demo --rm -it --restart=Never --image=<registry>/cleanroom/gi:<tag> \
  --overrides='{"spec":{"containers":[{"name":"gi-demo","image":"<registry>/cleanroom/gi:<tag>","command":["python","-m","gi.cli.demo"],"envFrom":[{"configMapRef":{"name":"gi-config"}},{"secretRef":{"name":"gi-secrets"}}]}]}}'
kubectl -n gi-test scale deploy/gi --replicas=2
```

## 5. Day-to-day operation

| Task | Command |
|---|---|
| Status | `kubectl -n gi-test get pods,svc,ingress` |
| Logs (all replicas) | `kubectl -n gi-test logs -l app.kubernetes.io/name=gi --tail=100` |
| Which replica imports | the one whose log shows `import: …` lines (it can change; that is normal) |
| Restart after a setting change | `kubectl -n gi-test rollout restart deployment/gi` |
| Roll back the last deployment | `kubectl -n gi-test rollout undo deployment/gi` (or re-run an older pipeline run) |
| More replicas | `replicas:` in `deployment.yaml` (any number is safe) |

**Backups:** the GI data lives in the on-premise MariaDB, so include the `gi` database in that server's normal backups. Always take one before a new version that changes the database (the release notes say so).

**ConfigMap changes** (e.g. `ISSUE_SOURCE`) only take effect after a restart. A pipeline run with a new image restarts the pods; otherwise run `rollout restart`.

## 6. Building on a company network

The image is built in two layers on top of a Python base image:
1. `pip install -r requirements.txt` (only rebuilt when `requirements.txt` changes);
2. the app code: `backend/gi`, the database migrations `backend/db`, and the web page `frontend/` (plain HTML/CSS/JavaScript, no build step, no Node.js).

The pipeline passes the company's base image as a build argument (variable `pythonImage` in `deploy/azure-pipelines.yml`). `Docker@2` ignores build arguments with `buildAndPush`, which is why the pipeline has separate **build** and **push** steps. Other build arguments go on the same `arguments:` line:

| Need | Build argument |
|---|---|
| The company's Python base image (Python 3.10 or newer, with `pip`) | `PYTHON_IMAGE=registry.example.local/base/python:3.12` |
| Internal PyPI mirror | `PIP_INDEX_URL=https://nexus.example.local/repository/pypi/simple` |
| Proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` |
| TLS-inspecting proxy | a BuildKit secret `company_ca` with the company root certificate (`--secret id=company_ca,src=ca.pem`, needs BuildKit, the default in Docker 23+) |

If the company base image already trusts the company certificate and its pip is set up for the internal mirror (common for approved base images), only `PYTHON_IMAGE` is needed.

The image runs as user `1000` (non-root) and needs no writable files, so it works with `readOnlyRootFilesystem: true`.

## 7. Real Oracle data without an Oracle connection: CSV upload

When GI cannot reach Oracle yet (for example on a test site), export the issue rows to a CSV file and upload it in **Settings › Import › Upload an Oracle export** (admin only).

1. ConfigMap: `ISSUE_SOURCE: "csv"`. GI then imports nothing automatically, shows no "import stale" warning, and hides "Run import now". Start from an empty `gi` database if mock issues were imported before, so they do not mix with real ones.
2. Export from Oracle, e.g. in SQL Developer (Run the query, then right-click the result › **Export** › format **csv**):
   ```sql
   SELECT SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL, STATE,
          TO_CHAR(INSERT_TIME, 'YYYY-MM-DD HH24:MI:SS') AS INSERT_TIME
     FROM SCHEMA.ISSUE_TABLE
    WHERE STATE = 'EMPLOYEE GOWN ISSUE'
      AND INSERT_TIME >= TO_DATE('2026-11-01', 'YYYY-MM-DD')
    ORDER BY INSERT_TIME;
   ```
   - The first line must be the column names; extra columns (such as `RECTIME`) are ignored, and other `STATE`s are skipped. `INSERT_TIME` is read as Phoenix time. Empty type, color, size or level cells are allowed (filled from the barcode master, step 6).
   - Comma, semicolon or tab separators work.
   - Dates like `20-NOV-26 09.15.30 AM` (Oracle's default) are also read, but **times must include seconds**. Don't open and save the file in Excel. Excel drops the seconds, and it keeps only 15 digits of a number, so a 16-digit barcode like `2399600002641084` becomes `2399600002641080`. Opening it in Excel only to look also shows the changed number; use a text editor, or import the column as Text.
3. Upload the file. A progress bar shows the upload, then "Importing N of M rows". The import runs on the server, so a large file doesn't hit request time limits. If the pod restarts during an import, the rows done so far are kept: upload the file again to finish. Rows already in GI (same `SUIT_BARCODE` and `INSERT_TIME`) are skipped, so uploading the same file twice, or files whose date ranges overlap, never counts an issue twice. If any row can't be read, nothing is imported and the problem lines are listed.
4. As with a real Oracle connection: map the values in **Settings › Oracle values**. A row is held until **all four** of its values (type, color, size, level) are mapped, so the first mappings may release 0 rows; the confirmation says how many rows were released and how many still wait, and enter the starting counts in **Settings › Full count**. Issues count against stock only after the starting count.
5. Repeat with a new export whenever you want newer issues; overlapping date ranges are fine.
6. **Barcode master** (Settings › Import › Barcode master, admin): upload a CSV export of the barcode master table too, and again whenever it changed. GI keeps each barcode's row with the latest `RECTIME`. It decides scans that come as several rows with other values, and fills empty type, color or size; until it can, those scans wait and do not count (Settings › Data quality › Waiting for the barcode master). Upload it before or after the issues; waiting scans are decided after each upload.
   The query returns only the **latest row of each barcode** (highest `RECTIME`; a row without `RECTIME` counts as the oldest, so it is used only when the barcode has no dated row). Two rows tied at the latest `RECTIME` both come back, so GI can see that it cannot tell them apart:
   ```sql
   SELECT SUIT_BARCODE, SUIT_CATEGORY, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, RECTIME
     FROM (SELECT SUIT_BARCODE, SUIT_CATEGORY, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE,
                  TO_CHAR(RECTIME, 'YYYY-MM-DD HH24:MI:SS') AS RECTIME,
                  RANK() OVER (PARTITION BY SUIT_BARCODE ORDER BY RECTIME DESC NULLS LAST) AS RK
             FROM SCHEMA.BARCODE_MASTER)
    WHERE RK = 1
    ORDER BY SUIT_BARCODE;
   ```
   Exporting every row also works (GI picks the latest itself), and so does an export of only recent changes: an older row never replaces a newer one.
   **Later uploads only need the new rows.** Settings › Import shows the newest `RECTIME` GI has; export only rows from that time on (an older row never replaces a newer one, so overlap is harmless):
   ```sql
   SELECT SUIT_BARCODE, SUIT_CATEGORY, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE,
          TO_CHAR(RECTIME, 'YYYY-MM-DD HH24:MI:SS') AS RECTIME
     FROM SCHEMA.BARCODE_MASTER
    WHERE RECTIME >= TO_DATE('2026-11-24 00:00:00', 'YYYY-MM-DD HH24:MI:SS')   -- newest RECTIME shown in GI
    ORDER BY SUIT_BARCODE, RECTIME;
   ```
   A large file (the first, full export of a few hundred thousand rows) is fine: GI checks it, then saves it in the background 2,000 rows at a time with a progress bar.

Later, with `ISSUE_SOURCE=oracle`, the rows already uploaded are recognised and not imported again.

## 8. Switching to the real Oracle later

1. Variable group: add `GI_ORACLE_PASSWORD` (secret).
2. Pipeline, "Update the Secret" step:
   `secretArguments: --from-literal=MARIADB_PASSWORD=$(GI_DB_PASSWORD) --from-literal=ORACLE_PASSWORD=$(GI_ORACLE_PASSWORD)`
3. ConfigMap: `ISSUE_SOURCE: "oracle"`, and uncomment and fill in `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_ISSUE_TABLE`, `ORACLE_BARCODE_MASTER_TABLE` (read daily; leave it out to keep uploading the barcode master as CSV), `ORACLE_BACKFILL_FROM`.
4. Network: pods can reach the Oracle server (usually port 1521).
5. Start from an empty `gi` database so mock issues do not mix with real ones (drop and re-create it with the DBA), then run the pipeline.
6. In the app: map the Oracle values, then the starting counts ([DEPLOYMENT_SOP.md §8.2](./DEPLOYMENT_SOP.md)).

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Pods `Running` but `READY 0/1` (with Istio: `1/2`) | Readiness: the database is unreachable or not set up | The log line `database not reachable or not set up (…)` gives the reason. Check `MARIADB_HOST`/port, the firewall from the cluster, and the user's allowed host in MariaDB |
| Probes fail with status 500, Istio sidecar log `request to probe app failed` | The probe port does not match the port GI listens on (default 8000, setting `PORT`) | Make `containerPort`, the probe ports and the Service `targetPort` match `PORT` |
| Log: `Access denied for user 'gi'` | Wrong password, or user not allowed from the cluster's addresses | Check `GI_DB_PASSWORD` and the `'gi'@'<host>'` grant |
| `CreateContainerConfigError`, "secret gi-secrets not found" | The Secret step did not run, or ran in another namespace | Check the pipeline's namespace and the createSecret step |
| `ImagePullBackOff` | Image name or registry credentials | Check `image:` in `deployment.yaml` and `imagePullSecrets` |
| Log: `This database was set up by an older GI version …` | The database was created before the 2026-11-23 schema consolidation | Drop and re-create the empty `gi` database (`DROP DATABASE gi; CREATE DATABASE gi CHARACTER SET utf8mb4;`, keep the `gi` user's grants), then restart the pods. Re-enter settings and starting counts, and upload the CSV exports again. |
| Log repeats `could not get the migration lock` | Another replica held the migration lock for over 5 minutes | Look at the other replica's log for the real error |
| Password with special characters not accepted by the createSecret step | Shell quoting in `secretArguments` | Use letters, digits and `-_.` in the password, or create the Secret with a script step: `kubectl create secret generic gi-secrets --from-literal=MARIADB_PASSWORD="$DB_PASSWORD" --dry-run=client -o yaml \| kubectl apply -f -` with `env: { DB_PASSWORD: $(GI_DB_PASSWORD) }` |
| "Import is running right now" in Settings | Another replica is importing | Wait a minute and retry |
| Pages load slowly | The database, the pod's CPU, or the network | `kubectl -n gi-test logs deploy/gi -c gi \| grep "slow request"` lists requests over 1 s with their time. Large times: give the pod more CPU (`resources.requests.cpu`, and no low CPU limit) or check the database server. Small times: the delay is in the network or Ingress. The browser's developer tools (Network tab) show each request's `Server-Timing`. |
