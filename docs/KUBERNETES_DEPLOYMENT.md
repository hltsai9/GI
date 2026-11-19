# GI on Kubernetes with Azure DevOps

How to run GI on the company Kubernetes cluster, built and deployed by an Azure DevOps pipeline, with the company's on-premise MariaDB. For a single Docker host instead, see [DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md).

| File | What it is |
|---|---|
| `Dockerfile` (repository root) | Builds the one GI image: web page + API + issue import |
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

With mock data, every replica generates its own copy, and the generator produces identical rows for any given day, so it does not matter which replica imports.

Health checks:
- **Readiness** (`/api/health`) fails while a pod cannot reach the database, so Kubernetes stops sending it traffic.
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
- [ ] The build agent can reach Docker Hub and the npm registry, or company mirrors (§6).

### 3.3 Azure DevOps
- [ ] **Docker registry service connection** to the company registry (e.g. `company-registry`).
- [ ] **Kubernetes service connection** to the test cluster/namespace (e.g. `company-k8s-test`).
- [ ] **Namespace** `gi-test` exists (or ask the platform team to create it).
- [ ] **Variable group** `gi-test` (Pipelines › Library) with the variable `GI_DB_PASSWORD`, marked secret (🔒). To use Azure Key Vault: link the group to the vault and add the secret there. Key Vault names cannot contain `_`, so name it `GI-DB-PASSWORD` and use `$(GI-DB-PASSWORD)` in the pipeline.
- [ ] Allow the pipeline to use the variable group and the service connections (first run asks).
- [ ] Optional: **Environment** `gi-test` (Pipelines › Environments) with an approval check.

### 3.4 Fill in the placeholders
| File | Change |
|---|---|
| `deploy/k8s/configmap.yaml` | `MARIADB_HOST`, and `MARIADB_USER` / `MARIADB_DATABASE` if different |
| `deploy/k8s/deployment.yaml` | `image:` → `<your registry>/<repository>:latest` (the pipeline replaces the tag) |
| `deploy/k8s/ingress.yaml` | `ingressClassName`, `host`, TLS if available |
| `deploy/azure-pipelines.yml` | Service connection names, registry host, repository, namespace, agent pool |

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
  --overrides='{"spec":{"containers":[{"name":"gi-demo","image":"<registry>/cleanroom/gi:<tag>","command":["sh","-c","node dist/mock-oracle/generate.js --out /tmp/mock && MOCK_ORACLE_DIR=/tmp/mock node dist/src/cli/demo.js"],"envFrom":[{"configMapRef":{"name":"gi-config"}},{"secretRef":{"name":"gi-secrets"}}]}]}}'
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

The pipeline's `Docker@2` step builds the root `Dockerfile`. If the build agent needs a proxy, an npm mirror or a mirrored base image, pass them as build arguments (see the comment in `deploy/azure-pipelines.yml`):

| Need | Build argument |
|---|---|
| Proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` |
| Internal npm mirror | `NPM_REGISTRY=https://nexus.example.local/repository/npm/` |
| Mirrored base image | `NODE_IMAGE=registry.example.local/library/node:22-alpine` |
| TLS-inspecting proxy | a BuildKit secret `company_ca` with the company root certificate (`--secret id=company_ca,src=ca.pem`, needs `DOCKER_BUILDKIT=1`) |

## 7. Switching to the real Oracle later

1. Variable group: add `GI_ORACLE_PASSWORD` (secret).
2. Pipeline, "Update the Secret" step:
   `secretArguments: --from-literal=MARIADB_PASSWORD=$(GI_DB_PASSWORD) --from-literal=ORACLE_PASSWORD=$(GI_ORACLE_PASSWORD)`
3. ConfigMap: `ISSUE_SOURCE: "oracle"`, and uncomment and fill in `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_ISSUE_TABLE`, `ORACLE_BACKFILL_FROM`.
4. Network: pods can reach the Oracle server (usually port 1521).
5. Start from an empty `gi` database so mock issues do not mix with real ones (drop and re-create it with the DBA), then run the pipeline.
6. In the app: map the Oracle values, then the starting counts ([DEPLOYMENT_SOP.md §8.2](./DEPLOYMENT_SOP.md)).

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Pods `Running` but `READY 0/1` | Readiness: the database is unreachable | Check `MARIADB_HOST`/port, the firewall from the cluster, and the user's allowed host in MariaDB |
| Log: `Access denied for user 'gi'` | Wrong password, or user not allowed from the cluster's addresses | Check `GI_DB_PASSWORD` and the `'gi'@'<host>'` grant |
| `CreateContainerConfigError`, "secret gi-secrets not found" | The Secret step did not run, or ran in another namespace | Check the pipeline's namespace and the createSecret step |
| `ImagePullBackOff` | Image name or registry credentials | Check `image:` in `deployment.yaml` and `imagePullSecrets` |
| Pods restart; log `could not get the migration lock` | Another replica held the migration lock for over 5 minutes | Look at the other replica's log for the real error |
| Password with special characters not accepted by the createSecret step | Shell quoting in `secretArguments` | Use letters, digits and `-_.` in the password, or create the Secret with a script step: `kubectl create secret generic gi-secrets --from-literal=MARIADB_PASSWORD="$DB_PASSWORD" --dry-run=client -o yaml \| kubectl apply -f -` with `env: { DB_PASSWORD: $(GI_DB_PASSWORD) }` |
| "Import is running right now" in Settings | Another replica is importing | Wait a minute and retry |
