"""Applies db/migrations/*.sql in order (under a lock, so several replicas can start together)."""
from __future__ import annotations

import sys
from pathlib import Path

import pymysql
from pymysql.constants import CLIENT

from .db import db_url

DB_DIR = Path(__file__).resolve().parent.parent / "db"


def _connect(url: str | None = None) -> pymysql.connections.Connection:
    u = db_url(url)
    return pymysql.connect(host=u.host, port=u.port or 3306, user=u.username, password=u.password or "",
                           database=u.database, charset="utf8mb4", client_flag=CLIENT.MULTI_STATEMENTS,
                           autocommit=True, init_command="SET time_zone = '+00:00'")


def _run_script(conn: pymysql.connections.Connection, sql: str) -> None:
    with conn.cursor() as cur:
        cur.execute(sql)
        while cur.nextset():
            pass


OLD_DATABASE = ("This database was set up by an older GI version (before 2026-11-24, when the schema was consolidated "
                "again). Drop and re-create the gi database (empty), then restart GI: it sets everything up again.")


def _refuse_old_schema(cur, applied: set[str]) -> None:
    """The migrations were consolidated into 001/002 (last on 2026-11-24). A database set up before that has other
    migration names, or a 001 without the barcode_master table; it must be re-created rather than half-updated."""
    known = {f.name for f in (DB_DIR / "migrations").glob("*.sql")}
    if applied - known:
        raise RuntimeError(OLD_DATABASE)
    if "001_schema.sql" in applied:
        cur.execute("""SELECT COUNT(*) FROM information_schema.tables
                        WHERE table_schema = DATABASE() AND table_name = 'barcode_master'""")
        if not cur.fetchone()[0]:
            raise RuntimeError(OLD_DATABASE)


def migrate(url: str | None = None, seed_dev: bool = False) -> list[str]:
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            # Only one replica migrates at a time (waits up to 5 minutes).
            cur.execute("SELECT GET_LOCK(CONCAT(DATABASE(), ':migrate'), 300)")
            if cur.fetchone()[0] != 1:
                raise RuntimeError("could not get the migration lock within 5 minutes")
            cur.execute("""CREATE TABLE IF NOT EXISTS schema_migration (
                name VARCHAR(191) PRIMARY KEY, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB""")
            cur.execute("SELECT name FROM schema_migration")
            applied = {r[0] for r in cur.fetchall()}
            _refuse_old_schema(cur, applied)
        ran = []
        for f in sorted((DB_DIR / "migrations").glob("*.sql")):
            if f.name in applied:
                continue
            _run_script(conn, f.read_text(encoding="utf-8"))
            with conn.cursor() as cur:
                cur.execute("INSERT INTO schema_migration (name) VALUES (%s)", (f.name,))
            ran.append(f.name)
        if seed_dev:
            for f in ("seed/dev-users.sql", "seed/mock-value-map.sql", "seed-dev.sql"):
                _run_script(conn, (DB_DIR / f).read_text(encoding="utf-8"))
        return ran
    finally:
        conn.close()


def apply_startup_seeds(dev_users: bool, mock_mapping: bool, url: str | None = None) -> list[str]:
    """Test installs: dev users (DEV_AUTH) and the mock data's value mapping (ISSUE_SOURCE=mock). Idempotent."""
    files = (["seed/dev-users.sql"] if dev_users else []) + (["seed/mock-value-map.sql"] if mock_mapping else [])
    if not files:
        return []
    conn = _connect(url)
    try:
        for f in files:
            _run_script(conn, (DB_DIR / f).read_text(encoding="utf-8"))
        return files
    finally:
        conn.close()


def reset_database(url: str | None = None) -> None:
    """Drops every table (tests and the dev reset only)."""
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()")
            tables = [r[0] for r in cur.fetchall()]
        if tables:
            _run_script(conn, "SET FOREIGN_KEY_CHECKS = 0; " + "; ".join(f"DROP TABLE `{t}`" for t in tables) + "; SET FOREIGN_KEY_CHECKS = 1;")
    finally:
        conn.close()


if __name__ == "__main__":
    seed = "--seed-dev" in sys.argv
    done = migrate(seed_dev=seed)
    print(("applied: " + ", ".join(done)) if done else "up to date", "(+ dev seed)" if seed else "")
