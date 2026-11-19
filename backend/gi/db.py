"""Database access: a pooled SQLAlchemy engine over PyMySQL, with '?' placeholders like the SQL files."""
from __future__ import annotations

import time
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, Callable, Iterator, TypeVar

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, URL, make_url
from sqlalchemy.exc import OperationalError

from .config import config

T = TypeVar("T")
_engine: Engine | None = None


def db_url(override: str | None = None) -> URL:
    """MARIADB_HOST/USER/PASSWORD/… when MARIADB_HOST is set, else MARIADB_URL (or an explicit URL)."""
    if override is None and config.MARIADB_HOST:
        return URL.create("mysql+pymysql", username=config.MARIADB_USER, password=config.MARIADB_PASSWORD,
                          host=config.MARIADB_HOST, port=config.MARIADB_PORT, database=config.MARIADB_DATABASE)
    url = make_url(override or config.MARIADB_URL)
    return url.set(drivername="mysql+pymysql")


def make_engine(override: str | None = None, **kw: Any) -> Engine:
    return create_engine(
        db_url(override),
        pool_size=10, max_overflow=5, pool_pre_ping=True, pool_recycle=1800,
        connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+00:00'"},
        **kw,
    )


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = make_engine()
    return _engine


def dispose() -> None:
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


def _clean(v: Any) -> Any:
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return v


def _run(conn: Connection, sql: str, params: tuple | list):
    # PyMySQL formats parameters with %s; literal % must be doubled only when there are parameters.
    if params:
        return conn.exec_driver_sql(sql.replace("%", "%%").replace("?", "%s"), tuple(params))
    return conn.exec_driver_sql(sql)


def rows(conn: Connection, sql: str, params: tuple | list = ()) -> list[dict]:
    res = _run(conn, sql, params)
    return [{k: _clean(v) for k, v in r.items()} for r in res.mappings().all()]


def one(conn: Connection, sql: str, params: tuple | list = ()) -> dict | None:
    r = rows(conn, sql, params)
    return r[0] if r else None


def execute(conn: Connection, sql: str, params: tuple | list = ()) -> Any:
    """Returns the cursor result; .lastrowid and .rowcount are available."""
    return _run(conn, sql, params)


def marks(n: int) -> str:
    return ",".join("?" * n)


@contextmanager
def connect() -> Iterator[Connection]:
    """A connection in autocommit-per-statement style (reads, single writes)."""
    with engine().connect() as conn:
        yield conn
        conn.commit()


_DEADLOCK, _LOCK_WAIT_TIMEOUT = 1213, 1205


def with_tx(fn: Callable[[Connection], T], attempts: int = 3) -> T:
    """Runs fn in a transaction, retrying on InnoDB deadlocks (BUILD_PLAN §2)."""
    for attempt in range(1, attempts + 1):
        try:
            with engine().begin() as conn:
                return fn(conn)
        except OperationalError as e:
            code = e.orig.args[0] if e.orig and e.orig.args else None
            if code in (_DEADLOCK, _LOCK_WAIT_TIMEOUT) and attempt < attempts:
                time.sleep(0.05 * attempt)
                continue
            raise
    raise AssertionError("unreachable")


def with_named_lock(name: str, fn: Callable[[], T], wait_seconds: int = 0) -> tuple[bool, T | None]:
    """Runs fn only if this process gets the named MariaDB lock (GET_LOCK), so with several replicas
    only one runs it at a time. Held on its own connection; freed automatically if the process dies.
    Returns (ran, result)."""
    with engine().connect() as conn:
        got = conn.execute(text("SELECT GET_LOCK(CONCAT(DATABASE(), :n), :w)"), {"n": f":{name}", "w": wait_seconds}).scalar()
        if got != 1:
            return False, None
        try:
            return True, fn()
        finally:
            try:
                conn.execute(text("SELECT RELEASE_LOCK(CONCAT(DATABASE(), :n))"), {"n": f":{name}"})
            except Exception:  # noqa: BLE001 - the lock dies with the connection anyway
                pass


def db_reachable() -> bool:
    try:
        with engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False
