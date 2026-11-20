# SOP — Deploying GI to a test environment with Docker

| | |
|---|---|
| Applies to | GI (Cleanroom Garment Inventory), test environment |
| Files | `Dockerfile` (repository root), `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/backup.sh` |
| Time needed | About 30 minutes the first time |

> Deploying to **Kubernetes with Azure DevOps** instead of a single Docker host? See [KUBERNETES_DEPLOYMENT.md](./KUBERNETES_DEPLOYMENT.md).

> **Test environments only, for now.** Company sign-in (SSO) is not connected yet. With `DEV_AUTH=true`, anyone who can open the page can choose to act as any user (floor staff, lead, admin). Keep the test site on the internal network.

---

## 1. What gets deployed

```
 Phones / laptops ──HTTP──▶ ┌──────────────────────────────────────┐
                            │ app  (image "gi", port 8000)         │──▶ Oracle (read-only)
                            │ web page + API + import scheduler    │     or mock data (no Oracle)
                            └──────────────────┬───────────────────┘
                              published as HTTP_PORT                 ▼
                                               ┌──────────────────────────────────────┐
                                               │ mariadb (official image, 11.4)       │
                                               │ volume: gi_mariadb-data              │
                                               └──────────────────────────────────────┘
```

| Container | Image | Purpose | Data |
|---|---|---|---|
| `app` | **`gi`**, built from this repository | Everything GI: serves the web page and the API, creates and updates the database tables, imports issues every 5 minutes, runs the daily sweep and alerts | mock data in volume `gi_mock-oracle-data` |
| `mariadb` | `mariadb:11.4` (official) | The GI database. Optional: you can use an existing MariaDB server instead (§10). | volume `gi_mariadb-data` |

- The `gi` image is the only one you build.
- The database runs separately, so its data survives image updates and can be backed up on its own.
- Only the app's port is published; the database is reachable only inside the Docker network.
- Several `app` containers are safe: only one imports at a time (it holds a lock in MariaDB). On a single Docker host one is enough.

### Without an Oracle connection
With `ISSUE_SOURCE=mock` (the default), the app generates realistic mock issue data inside its own container and imports it like real Oracle rows. The mock data has the real system's quirks:
- scan time in Taipei time, record time in Phoenix time;
- records entered up to ~15 hours late;
- unregistered barcodes reported as GOWN / OTHER / OTHER.

No Oracle access, account or network route is needed. Switching to the real Oracle later is a configuration change (§8.3).

## 2. Before you start

### 2.1 Host
- [ ] A Linux server or VM. Suggested size: 2 vCPU, 4 GB RAM, 20 GB free disk.
- [ ] Docker Engine 24 or newer, and Docker Compose v2.20 or newer. Check with `docker version` and `docker compose version`.
- [ ] Clock synchronized (NTP). The import and the "issued today" numbers depend on the right time; the time zones are set in the app.
- [ ] Git access to the `hltsai9/GI` repository, or a copy of it.

### 2.2 Network
- [ ] **Inbound:** users' phones and laptops can reach the host on the chosen port (`HTTP_PORT`, default 8080).
- [ ] **Outbound, when building the image:** Docker Hub (base images) and PyPI (Python packages), or company mirrors of them (§5.2).
- [ ] **Outbound, at run time:** nothing with mock data. With real Oracle data later: the host can reach the Oracle database (usually TCP 1521).

### 2.3 Information to collect
| Item | Needed when | Example |
|---|---|---|
| Host name and port for the site | always | `gi-test.example.local:8080` |
| Two database passwords (app user, root) | using the MariaDB container | letters and digits, 16+ characters |
| Proxy, PyPI mirror, company Python base image, company root certificate | if the build network needs them | see §5.2 |
| Oracle connect string, read-only account, issue table | only later, for `ISSUE_SOURCE=oracle` | `oradb.example.local:1521/ISSUEPDB`, `GI_READER`, `SCHEMA.ISSUE_TABLE` |

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

Settings to fill in for a first deployment without Oracle (everything else has working defaults):

| Setting | What to put |
|---|---|
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | New passwords for the MariaDB container. Use letters and digits only (they go into a URL). |
| `HTTP_PORT` | Port for the web page on the host (default `8080`). |
| `ISSUE_SOURCE` | Leave `mock`. |
| `DEV_AUTH` | Leave `true` until SSO is connected (otherwise nobody can sign in). |
| `GI_VERSION` | Tag for the image you build, e.g. `2026-11-19`. Makes rollback easy (§9). |

Never commit `deploy/.env`; it is in `.gitignore`.

## 5. Build the image

### 5.1 Normal case
```bash
cd /opt/gi/deploy
docker compose build
docker images gi                       # gi:<GI_VERSION>, about 270 MB
```

Without Compose, the same image can be built from the repository root: `docker build -t gi:2026-11-19 /opt/gi`.

The image is a Python base image (`python:3.12-slim` by default; any Python 3.10 or newer) plus the packages in `requirements.txt`, the backend code and the web page. The web page is plain HTML, CSS and JavaScript, so there is no build step and no Node.js.

### 5.2 Company networks
Set these in `deploy/.env` as needed, then run `docker compose build` again:

| Problem | Setting |
|---|---|
| Downloads must go through a proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`. Do **not** list `pypi.org` / `files.pythonhosted.org` in `NO_PROXY` if they must go through the proxy. |
| The proxy runs on the build machine itself (`127.0.0.1` / `localhost`) | `BUILD_NETWORK=host` |
| The proxy inspects HTTPS (errors such as `CERTIFICATE_VERIFY_FAILED`, `unable to get local issuer certificate`) | `COMPANY_CA_FILE=/path/to/company-root-ca.pem` |
| pip must use an internal mirror (Nexus, Artifactory) | `PIP_INDEX_URL=https://nexus.example.local/repository/pypi/simple` |
| The company provides its own Python base image | `PYTHON_IMAGE=registry.example.local/base/python:3.12` (Python 3.10 or newer, with `pip`) |
| Docker Hub refuses (`429 Too Many Requests`) or is blocked | Use a mirror: `PYTHON_IMAGE=…/python:3.12-slim`, `MARIADB_IMAGE=…/mariadb:11.4`, or `docker login` to raise the limit |

### 5.3 Hosts without internet access
Build on a machine that has access, then copy the images:

```bash
# on the build machine
docker compose build
docker save gi:$GI_VERSION mariadb:11.4 | gzip > gi-images.tar.gz
# copy gi-images.tar.gz and the repository to the test host, then on the test host:
gunzip -c gi-images.tar.gz | docker load
```

Or push to the company registry: set `IMAGE_PREFIX=registry.example.local/cleanroom/gi`, run `docker compose build && docker compose push app`, and on the test host `docker compose pull`.

## 6. Start

```bash
cd /opt/gi/deploy
docker compose up -d
docker compose ps                      # wait until both say "(healthy)", about 1 minute
docker compose logs -f app             # Ctrl+C to stop following
```

On first start the app:
1. creates the database tables (migrations run automatically on every start);
2. creates the four test users, when `DEV_AUTH=true`;
3. with `ISSUE_SOURCE=mock`: generates the mock Oracle data and maps its codes;
4. runs the first issue import. The log shows `import: … new rows`.

## 7. Check it works

- [ ] `curl -s http://localhost:$HTTP_PORT/healthz` answers `ok`.
- [ ] `curl -s http://localhost:$HTTP_PORT/api/health` answers `{"ok":true}` (app and database).
- [ ] Open `http://<host>:<HTTP_PORT>` on a laptop: you get the sidebar layout. On a phone: tabs across the top.
- [ ] **Settings › This device**: switch between Floor staff, Cleanroom lead, Admin and Viewer.
- [ ] **Settings › Import** (as Admin): "Last import" is recent; there are no unexpected alerts.
- [ ] As Floor staff: **Receive** → add a line → **Post delivery** shows "Posted". The item's number goes up in **Stock**.

## 8. First-time setup in the app

### 8.1 With mock data (`ISSUE_SOURCE=mock`)
Mock issues are imported but do not change stock until each fab has a starting count. Either:

- **Do it like on go-live day:** **Settings › Full count**. Pick the fab, enter counts, set "Counting finished at", save. Repeat for the other fab.
- **Or load the demo history:** starting counts 21 days ago and a morning delivery every day since, the same data as the GitHub demo (https://hltsai9.github.io/GI/). **This erases the GI database first.**
  ```bash
  cd /opt/gi/deploy
  docker compose stop app
  docker compose run --rm --no-deps app python -m gi.cli.demo
  docker compose start app
  ```

### 8.2 With real Oracle data (later, `ISSUE_SOURCE=oracle`)
1. **Settings › Import** shows the first run. The history from `ORACLE_BACKFILL_FROM` is loaded in that run.
2. **Settings › Oracle values**: every `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE` and `SUIT_LEVEL` value found is listed. Map each one to a GI value, or **Ignore** (e.g. a test location). Rows waiting for a value are applied as soon as it is mapped.
3. **Settings › Sizes & colors**: add any size or color the mapping needs.
4. Floor staff count everything; enter it in **Settings › Full count** per fab, with the time counting finished.
5. Set minimums in **Stock › Grid** (tap a cell, −/+ "Alert below").

### 8.3 Switching from mock data to real Oracle data
Mock issues already imported would mix with real ones, so start with an empty database:
```bash
cd /opt/gi/deploy
./backup.sh                            # if anything in the test database should be kept
docker compose down -v                 # -v DELETES the database volume
vi .env                                # ISSUE_SOURCE=oracle, ORACLE_CONNECT_STRING, ORACLE_USER,
                                       # ORACLE_PASSWORD, ORACLE_ISSUE_TABLE, ORACLE_BACKFILL_FROM
docker compose up -d
```
No rebuild is needed: the same image reads Oracle when `ISSUE_SOURCE=oracle`. Then follow §8.2.

### 8.4 Real Oracle data without an Oracle connection: CSV upload

When GI cannot reach Oracle yet (for example on a test site), export the issue rows to a CSV file and upload it in **Settings › Import › Upload an Oracle export** (admin only).

1. In `deploy/.env`: `ISSUE_SOURCE=csv`. GI then imports nothing automatically, shows no "import stale" warning, and hides "Run import now". Start from an empty `gi` database if mock issues were imported before, so they do not mix with real ones.
2. Export from Oracle, e.g. in SQL Developer (Run the query, then right-click the result › **Export** › format **csv**):
   ```sql
   SELECT SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL, STATE,
          TO_CHAR(INSERT_TIME, 'YYYY-MM-DD HH24:MI:SS') AS INSERT_TIME,
          TO_CHAR(RECTIME,     'YYYY-MM-DD HH24:MI:SS') AS RECTIME
     FROM SCHEMA.ISSUE_TABLE
    WHERE STATE = 'EMPLOYEE GOWN ISSUE'
      AND INSERT_TIME >= TO_DATE('2026-11-01', 'YYYY-MM-DD')
    ORDER BY INSERT_TIME;
   ```
   - The first line must be the column names; extra columns are ignored, and other `STATE`s are skipped.
   - Comma, semicolon or tab separators work.
   - Dates like `20-NOV-26 09.15.30 AM` (Oracle's default) are also read, but **times must include seconds**. Don't open and save the file in Excel. Excel drops the seconds, and it keeps only 15 digits of a number, so a 16-digit barcode like `2399600002641084` becomes `2399600002641080`. Opening it in Excel only to look also shows the changed number; use a text editor, or import the column as Text.
3. Upload the file. A progress bar shows the upload, then "Importing N of M rows". The import runs on the server, so a large file doesn't hit request time limits. If the pod restarts during an import, the rows done so far are kept: upload the file again to finish. Rows already in GI (same `SUIT_BARCODE` and `INSERT_TIME`) are skipped, so uploading the same file twice, or files whose date ranges overlap, never counts an issue twice. If any row can't be read, nothing is imported and the problem lines are listed.
4. As with a real Oracle connection: map the values in **Settings › Oracle values**. A row is held until **all four** of its values (type, color, size, level) are mapped, so the first mappings may release 0 rows; the confirmation says how many rows were released and how many still wait, and enter the starting counts in **Settings › Full count**. Issues count against stock only after the starting count.
5. Repeat with a new export whenever you want newer issues; overlapping date ranges are fine.

Later, with `ISSUE_SOURCE=oracle`, the rows already uploaded are recognised and not imported again.

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
3. `docker compose up -d` now starts only the `app` container.

Without Compose at all, the image runs on its own:
```bash
docker run -d --name gi --restart unless-stopped -p 8080:8000 \
  -e MARIADB_URL='mysql://gi:<password>@<db-host>:3306/gi' -e ISSUE_SOURCE=mock -e DEV_AUTH=true \
  gi:<GI_VERSION>
```

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
cd /opt/gi/deploy
docker compose stop app
gunzip -c /opt/gi-backups/gi-YYYY-MM-DD-HHMM.sql.gz | docker compose exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" gi'
docker compose start app
```

With an existing MariaDB server (§10), use that server's normal backup process.

## 12. Day-to-day operation

| Task | Command (in `/opt/gi/deploy`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs --since 1h app` (or `mariadb`) |
| Restart | `docker compose restart app` |
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
- [ ] Later, with Oracle: the account is read-only and limited to the issue table.
- [ ] For HTTPS, put the company reverse proxy or load balancer in front of `HTTP_PORT` and terminate TLS there. GI needs no change.
- [ ] Database backups are stored outside the Docker host, or copied off it.

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build: `429 Too Many Requests` from `registry-1.docker.io` | Docker Hub rate limit | Wait and retry, `docker login`, or use a mirror (`PYTHON_IMAGE`, `MARIADB_IMAGE`) |
| Build: pip `Could not find a version that satisfies the requirement` or `Connection timed out` | pip cannot reach PyPI | Set the proxy or `PIP_INDEX_URL` (§5.2). Make sure `NO_PROXY` does not include PyPI. Use `BUILD_NETWORK=host` if the proxy is on `127.0.0.1`. |
| Build: certificate errors (`CERTIFICATE_VERIFY_FAILED`) | The proxy inspects HTTPS | `COMPANY_CA_FILE=/path/to/root-ca.pem` |
| Build: `the --mount option requires BuildKit` | Old Docker without BuildKit | Docker 23 or newer, or set `DOCKER_BUILDKIT=1` |
| `app` stays unhealthy; log repeats `database not reachable or not set up (… Can't connect …` or `… Access denied …)` | Wrong database host, URL or password, or the database is down. GI keeps retrying and recovers by itself once the database answers. | Check `DB_PASSWORD` / `MARIADB_URL`. A password with special characters must be URL-encoded in `MARIADB_URL`. |
| `app` restarts; log mentions `ORACLE_… is required` | `ISSUE_SOURCE=oracle` without the Oracle settings | Set `ISSUE_SOURCE=mock`, or fill in the `ORACLE_*` settings |
| Page shows "unknown user" or "SSO sign-in is not configured" | `DEV_AUTH` is not `true` | Set `DEV_AUTH=true` and `docker compose up -d` |
| Stock does not change although issues are imported | No starting count yet for that fab | §8.1 |
| Many rows "held" in **Settings › Import** | Oracle values not mapped yet | **Settings › Oracle values** (§8.2 step 2) |
| "Issues up to" is hours behind | Normal: records are entered up to ~15 h after the scan | If no import ran for twice the interval, an alert appears; check `docker compose logs app` |
| Port already in use on `up` | Something else uses `HTTP_PORT` | Change `HTTP_PORT` in `.env` |

## 15. Reference

### 15.1 Settings (`deploy/.env`)
| Setting | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `db` | `db` runs the MariaDB container |
| `IMAGE_PREFIX`, `GI_VERSION` | `gi`, `latest` | Image name `<prefix>:<version>` |
| `HTTP_PORT` | `8080` | Host port for the site (the container listens on 8000) |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | — | MariaDB container passwords |
| `MARIADB_URL` | built from `DB_PASSWORD` | Database URL, e.g. for an existing server |
| `ISSUE_SOURCE` | `mock` | `mock` (generated test data), `oracle` (read Oracle), or `csv` (no automatic import; upload Oracle exports, §8.4) |
| `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_ISSUE_TABLE`, `ORACLE_SUIT_TABLE` | — | Oracle access (read-only), only for `oracle` |
| `ORACLE_POLL_SECONDS` | `300` | Import interval, 300–43200 s |
| `ORACLE_BACKFILL_FROM` | `2026-10-01 00:00:00` | First `RECTIME` (Phoenix time) read on a fresh install |
| `DEV_AUTH` | `true` | Choose the user in the app (no SSO yet) |
| `SITE_TIMEZONE`, `ORACLE_INSERT_TIME_ZONE`, `ORACLE_RECTIME_ZONE` | Phoenix, Taipei, Phoenix | Time zones (URD ORA-12) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `BUILD_NETWORK`, `PIP_INDEX_URL`, `COMPANY_CA_FILE`, `PYTHON_IMAGE`, `MARIADB_IMAGE` | — | Building on company networks (§5.2) |

### 15.2 Health endpoints
- `GET /healthz`: the app is up.
- `GET /api/health`: the app is up. Used by the container health check.

### 15.3 Volumes
- `gi_mariadb-data`: the GI database (MariaDB container only).
- `gi_mock-oracle-data`: generated mock Oracle data (`ISSUE_SOURCE=mock`).

`docker compose down` keeps volumes; `docker compose down -v` **deletes them**.
