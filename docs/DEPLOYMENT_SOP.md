# SOP — Deploying GI to a test environment with Docker

| | |
|---|---|
| Applies to | GI (Cleanroom Garment Inventory), test environment |
| Files | `deploy/docker-compose.yml`, `deploy/.env.example`, `backend/Dockerfile`, `frontend/Dockerfile` |
| Time needed | About 1 hour the first time (most of it is building images) |

> **Test environments only, for now.** Company sign-in (SSO) is not connected yet. With `DEV_AUTH=true`, anyone who can open the page can choose to act as any user (floor staff, lead, admin). Keep the test site on the internal network.

---

## 1. What gets deployed

```
 Phones / laptops ──HTTP──▶ ┌────────────────────────────┐
                            │ frontend  (nginx, port 80) │──/api──▶ ┌───────────────────────────┐
                            │ web page                   │          │ backend (Node.js, 3000)   │──▶ Oracle (read-only)
                            └────────────────────────────┘          │ API + import scheduler    │     or mock data
                               published as HTTP_PORT               └─────────────┬─────────────┘
                                                                                   ▼
                                                                    ┌───────────────────────────┐
                                                                    │ mariadb (11.4)            │
                                                                    │ volume: gi_mariadb-data   │
                                                                    └───────────────────────────┘
```

| Container | Image | Purpose | Data |
|---|---|---|---|
| `frontend` | `gi-frontend` (nginx) | Serves the web page; forwards `/api` to the backend | none |
| `backend` | `gi-backend` (Node.js 22) | API, database migrations, issue import every 5 min, daily sweep, alerts | mock data in volume `gi_mock-oracle-data` |
| `mariadb` | `mariadb:11.4` | GI database. Optional: you can use an existing MariaDB server instead (§10). | volume `gi_mariadb-data` |

Only the `frontend` port is published. The database and backend are reachable only inside the Docker network.

**Run exactly one backend container.** It runs the import scheduler; two would import side by side.

## 2. Before you start

### 2.1 Host
- [ ] A Linux server or VM. Suggested size: 2 vCPU, 4 GB RAM, 20 GB free disk.
- [ ] Docker Engine 24 or newer, and Docker Compose v2.20 or newer. Check with `docker version` and `docker compose version`.
- [ ] Clock synchronized (NTP). The import and the "issued today" numbers depend on the right time; the time zones are set in the app.
- [ ] Git access to the `hltsai9/GI` repository, or a copy of it.

### 2.2 Network
- [ ] **Inbound:** users' phones and laptops can reach the host on the chosen port (`HTTP_PORT`, default 8080).
- [ ] **Outbound, when building images:** Docker Hub (base images) and the npm registry, or company mirrors of them (§5.2).
- [ ] **Outbound, at run time, with real Oracle data:** the backend host can reach the Oracle database (usually TCP 1521).

### 2.3 Information to collect
| Item | Needed when | Example |
|---|---|---|
| Host name and port for the site | always | `gi-test.example.local:8080` |
| Two database passwords (app user, root) | using the MariaDB container | letters and digits, 16+ characters |
| Oracle connect string | `ISSUE_SOURCE=oracle` | `oradb.example.local:1521/ISSUEPDB` |
| Read-only Oracle account and password | `ISSUE_SOURCE=oracle` | `GI_READER` |
| Issue table name | `ISSUE_SOURCE=oracle` | `SCHEMA.ISSUE_TABLE` |
| Proxy, npm mirror, company root certificate | if the build network needs them | see §5.2 |

## 3. Get the code

```bash
sudo mkdir -p /opt/gi && sudo chown "$USER" /opt/gi
git clone https://github.com/hltsai9/GI.git /opt/gi
cd /opt/gi
git checkout main                      # or the branch / tag you were asked to deploy
```

## 4. Configure

```bash
cd /opt/gi/deploy
cp .env.example .env
chmod 600 .env                         # it will hold passwords
vi .env
```

Settings to fill in (all others have working defaults):

| Setting | What to put |
|---|---|
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | New passwords for the MariaDB container. Use letters and digits only (they go into a URL). |
| `HTTP_PORT` | Port for the web page on the host (default `8080`). |
| `ISSUE_SOURCE` | `mock` to try the system with generated data; `oracle` for the real issuing system. |
| `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_ISSUE_TABLE` | Only for `ISSUE_SOURCE=oracle`. |
| `ORACLE_BACKFILL_FROM` | Only for `oracle`: the first record time (`RECTIME`, Phoenix time) to load history from, e.g. `2026-10-01 00:00:00`. |
| `DEV_AUTH` | Leave `true` until SSO is connected (otherwise nobody can sign in). |
| `GI_VERSION` | Tag for the images you build, e.g. `2026-11-19`. Makes rollback easy (§9). |

Never commit `deploy/.env`; it is in `.gitignore`.

## 5. Build the images

### 5.1 Normal case
```bash
cd /opt/gi/deploy
docker compose build
docker images | grep gi-               # gi-backend and gi-frontend, tagged GI_VERSION
```

### 5.2 Company networks
Set these in `deploy/.env` as needed, then run `docker compose build` again:

| Problem | Setting |
|---|---|
| Downloads must go through a proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`. Do **not** list `registry.npmjs.org` in `NO_PROXY` if it must go through the proxy. |
| The proxy runs on the build machine itself (`127.0.0.1` / `localhost`) | `BUILD_NETWORK=host` |
| The proxy inspects HTTPS (errors such as `SELF_SIGNED_CERT_IN_CHAIN`, `unable to get local issuer certificate`) | `COMPANY_CA_FILE=/path/to/company-root-ca.pem` |
| npm must use an internal mirror (Nexus, Artifactory) | `NPM_REGISTRY=https://nexus.example.local/repository/npm/` |
| Docker Hub refuses (`429 Too Many Requests`) or is blocked | Use a mirror: `NODE_IMAGE=…/node:22-alpine`, `NGINX_IMAGE=…/nginx:1.27-alpine`, `MARIADB_IMAGE=…/mariadb:11.4`, or `docker login` to raise the limit |

### 5.3 Hosts without internet access
Build on a machine that has access, then copy the images:

```bash
# on the build machine
docker compose build
docker save gi-backend:$GI_VERSION gi-frontend:$GI_VERSION mariadb:11.4 | gzip > gi-images.tar.gz
# copy gi-images.tar.gz and the repository to the test host, then on the test host:
gunzip -c gi-images.tar.gz | docker load
```

Or push to the company registry: set `IMAGE_PREFIX=registry.example.local/cleanroom/gi`, run `docker compose build && docker compose push`, and on the test host `docker compose pull`.

## 6. Start

```bash
cd /opt/gi/deploy
docker compose up -d
docker compose ps                      # wait until all three say "(healthy)", about 1 minute
docker compose logs -f backend         # Ctrl+C to stop following
```

On first start the backend:
1. creates the database tables (migrations run automatically on every start);
2. creates the four test users, when `DEV_AUTH=true`;
3. with `ISSUE_SOURCE=mock`: generates the mock Oracle data and maps its codes;
4. runs the first issue import. The log shows `import: … new rows`.

## 7. Check it works

- [ ] `curl -s http://localhost:$HTTP_PORT/healthz` answers `ok` (web server).
- [ ] `curl -s http://localhost:$HTTP_PORT/api/health` answers `{"ok":true}` (backend and database).
- [ ] Open `http://<host>:<HTTP_PORT>` on a laptop: you get the sidebar layout. On a phone: tabs across the top.
- [ ] **Settings › This device**: switch between Floor staff, Cleanroom lead, Admin and Viewer.
- [ ] **Settings › Import** (as Admin): "Last import" is recent; there are no unexpected alerts.
- [ ] **Settings › Oracle values**: no values marked **New**. With real Oracle data, see §8.2.
- [ ] As Floor staff: **Receive** → add a line → **Post delivery** shows "Posted". The item's number goes up in **Stock**.

## 8. First-time setup in the app

### 8.1 With mock data (`ISSUE_SOURCE=mock`)
Mock issues are imported but do not change stock until each fab has a starting count. Either:

- **Do it like on go-live day:** **Settings › Full count**. Pick the fab, enter counts, set "Counting finished at", save. Repeat for the other fab.
- **Or load the demo history:** starting counts 21 days ago and a morning delivery every day since, the same data as the GitHub demo. **This erases the GI database first.**
  ```bash
  cd /opt/gi/deploy
  docker compose stop backend
  docker compose run --rm --no-deps backend node dist/src/cli/demo.js
  docker compose start backend
  ```

### 8.2 With real Oracle data (`ISSUE_SOURCE=oracle`)
1. **Settings › Import** shows the first run. The history from `ORACLE_BACKFILL_FROM` is loaded in that run.
2. **Settings › Oracle values**: every `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE` and `SUIT_LEVEL` value found is listed. Map each one to a GI value, or **Ignore** (e.g. a test location). Rows waiting for a value are applied as soon as it is mapped.
3. **Settings › Sizes & colors**: add any size or color the mapping needs.
4. Floor staff count everything; enter it in **Settings › Full count** per fab, with the time counting finished.
5. Set minimums in **Stock › Grid** (tap a cell, −/+ "Alert below").

### 8.3 Switching from mock data to real Oracle data
Mock issues already imported would mix with real ones, so start with an empty database:
```bash
cd /opt/gi/deploy
docker compose down -v                 # -v DELETES the database and mock data volumes
vi .env                                # ISSUE_SOURCE=oracle and the ORACLE_* settings
docker compose up -d
```
Then follow §8.2.

## 9. Updating to a new version

```bash
cd /opt/gi
git fetch && git checkout <new branch or tag> && git pull
less docs/RELEASE_NOTES.md             # what changed
cd deploy
./backup.sh                            # always back up the database first (§11)
sed -i 's/^GI_VERSION=.*/GI_VERSION=<new tag>/' .env
docker compose build
docker compose up -d                   # database migrations run automatically
docker compose ps
```

**Roll back:** set `GI_VERSION` back to the previous tag and run `docker compose up -d`. If the new version changed the database (the release notes say so), restore the backup taken before the update (§11).

## 10. Using an existing MariaDB server instead of the container

1. On the MariaDB server (10.11+, ideally 11.4), as an administrator:
   ```sql
   CREATE DATABASE gi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'gi'@'%' IDENTIFIED BY '<password>';
   GRANT ALL ON gi.* TO 'gi'@'%';
   ```
2. In `deploy/.env`: remove `db` from `COMPOSE_PROFILES` (leave it empty) and set
   `MARIADB_URL=mysql://gi:<password>@<db-host>:3306/gi`.
3. `docker compose up -d` now starts only `backend` and `frontend`.

## 11. Backups

Back up the GI database daily, and always before an update. `deploy/backup.sh` writes a compressed dump to `/opt/gi-backups` and deletes backups older than 14 days (`BACKUP_DIR` and `KEEP_DAYS` change that):

```bash
/opt/gi/deploy/backup.sh
```

Daily at 02:30 with cron (`crontab -e` as a user allowed to run Docker):
```
30 2 * * * /opt/gi/deploy/backup.sh >> /opt/gi-backups/backup.log 2>&1
```

**Restore:**
```bash
docker compose stop backend
gunzip -c /opt/gi-backups/gi-YYYY-MM-DD.sql.gz | docker compose exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" gi'
docker compose start backend
```

With an existing MariaDB server (§10), use that server's normal backup process.

## 12. Day-to-day operation

| Task | Command (in `/opt/gi/deploy`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs --since 1h backend` (or `frontend`, `mariadb`) |
| Restart everything | `docker compose restart` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Run the import now | **Settings › Import › Run import now** (as Admin) |
| Disk use | `docker system df` |

What to watch:
- **Settings › Import** shows alerts:
  - the import failed or has not run for twice the import interval;
  - the daily sweep found rows the regular import missed;
  - a record's `RECTIME` is earlier than its scan time.

  Mark them checked once handled.
- After a host reboot, containers come back by themselves (`restart: unless-stopped`).

## 13. Security checklist

- [ ] The site is reachable only from the internal network (`DEV_AUTH=true` means anyone can act as any user).
- [ ] `deploy/.env` is `chmod 600` and not in git.
- [ ] The Oracle account is read-only and limited to the issue table (and the suit master table, if used).
- [ ] For HTTPS, put the company reverse proxy or load balancer in front of `HTTP_PORT` and terminate TLS there. GI needs no change.
- [ ] Database backups are stored outside the Docker host, or copied off it.

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build: `429 Too Many Requests` from `registry-1.docker.io` | Docker Hub rate limit | Wait and retry, `docker login`, or use a mirror (`NODE_IMAGE`, `NGINX_IMAGE`, `MARIADB_IMAGE`) |
| Build: `npm error Exit handler never called` after about 70 s, or `ETIMEDOUT` | npm cannot reach the registry | Set the proxy (§5.2). Make sure `NO_PROXY` does not include the registry. Use `BUILD_NETWORK=host` if the proxy is on `127.0.0.1`. |
| Build: certificate errors (`SELF_SIGNED_CERT_IN_CHAIN`) | The proxy inspects HTTPS | `COMPANY_CA_FILE=/path/to/root-ca.pem` |
| `backend` stays unhealthy; log shows `ECONNREFUSED` or `Access denied` | Wrong database URL or password | Check `DB_PASSWORD` / `MARIADB_URL`. A password with special characters must be URL-encoded in `MARIADB_URL`. |
| `backend` restarts; log mentions `ORACLE_… is required` | `ISSUE_SOURCE=oracle` without the Oracle settings | Fill in `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_ISSUE_TABLE` |
| Page shows "unknown user" or "SSO sign-in is not configured" | `DEV_AUTH` is not `true` | Set `DEV_AUTH=true` and `docker compose up -d` |
| Stock does not change although issues are imported | No starting count yet for that fab | §8.1 / §8.2 step 4 |
| Many rows "held" in **Settings › Import** | Oracle values not mapped yet | **Settings › Oracle values** (§8.2 step 2) |
| "Issues up to" is hours behind | Normal: records are entered up to ~15 h after the scan | If no import ran for twice the interval, an alert appears; check `docker compose logs backend` |
| Port already in use on `up` | Something else uses `HTTP_PORT` | Change `HTTP_PORT` in `.env` |
| Text in a plain font instead of serif | An old browser cache | Reload the page. The font is bundled in the app, so no internet is needed. |

## 15. Reference

### 15.1 Settings (`deploy/.env`)
| Setting | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `db` | `db` runs the MariaDB container |
| `IMAGE_PREFIX`, `GI_VERSION` | `gi`, `latest` | Image names: `<prefix>-backend:<version>` |
| `HTTP_PORT` | `8080` | Host port for the web page |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | — | MariaDB container passwords |
| `MARIADB_URL` | built from `DB_PASSWORD` | Database URL, e.g. for an existing server |
| `ISSUE_SOURCE` | `mock` | `mock` or `oracle` |
| `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_ISSUE_TABLE`, `ORACLE_SUIT_TABLE` | — | Oracle access (read-only) |
| `ORACLE_POLL_SECONDS` | `300` | Import interval, 300–43200 s |
| `ORACLE_BACKFILL_FROM` | `2026-10-01 00:00:00` | First `RECTIME` (Phoenix time) read on a fresh install |
| `DEV_AUTH` | `true` | Choose the user in the app (no SSO yet) |
| `SITE_TIMEZONE`, `ORACLE_INSERT_TIME_ZONE`, `ORACLE_RECTIME_ZONE` | Phoenix, Taipei, Phoenix | Time zones (URD ORA-12) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `BUILD_NETWORK`, `NPM_REGISTRY`, `COMPANY_CA_FILE`, `NODE_IMAGE`, `NGINX_IMAGE`, `MARIADB_IMAGE` | — | Building on company networks (§5.2) |

### 15.2 Health endpoints
- `GET /healthz`: nginx is up.
- `GET /api/health`: the backend is up. Used by the container health checks.

### 15.3 Volumes
- `gi_mariadb-data`: the GI database (MariaDB container only).
- `gi_mock-oracle-data`: generated mock Oracle data (`ISSUE_SOURCE=mock`).

`docker compose down` keeps volumes; `docker compose down -v` **deletes them**.
