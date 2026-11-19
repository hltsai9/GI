"""Tests run against a separate database (default mysql://gi:gi@localhost:3306/gi_test), which they reset."""
import os
import random
import string

os.environ.setdefault("MARIADB_URL", "mysql://gi:gi@localhost:3306/gi_test")
os.environ["MARIADB_HOST"] = ""
os.environ["DEV_AUTH"] = "true"

import pytest  # noqa: E402

from gi import db as gidb  # noqa: E402
from gi.config import config  # noqa: E402
from gi.db import connect, one, rows  # noqa: E402
from gi.migrate import migrate, reset_database  # noqa: E402
from gi.stock_items import reset_caches  # noqa: E402


@pytest.fixture
def fresh_db():
    if "gi_test" not in config.MARIADB_URL:
        raise RuntimeError("tests must run against the gi_test database")
    gidb.dispose()
    reset_caches()
    reset_database()
    migrate(seed_dev=True)
    config.ORACLE_MAX_ROWS = 5000
    config.ORACLE_BACKFILL_FROM = "2026-11-01 00:00:00"
    yield
    gidb.dispose()


def user_id(subject: str = "dev-lead") -> int:
    with connect() as c:
        return one(c, "SELECT id FROM app_user WHERE sso_subject = ?", [subject])["id"]  # type: ignore[index]


def ref_ids() -> dict[str, dict[str, int]]:
    def q(sql: str) -> dict[str, int]:
        with connect() as c:
            return {r["k"]: r["id"] for r in rows(c, sql)}
    return {"type": q("SELECT code k, id FROM garment_type"), "color": q("SELECT name k, id FROM color"),
            "size": q("SELECT code k, id FROM size"), "loc": q("SELECT code k, id FROM location")}


def row(INSERT_TIME: str, RECTIME: str, **p) -> dict:  # noqa: N803
    """A mock Oracle row. Times are naive: INSERT_TIME = Taipei, RECTIME = Phoenix."""
    return {
        "SUIT_BARCODE": p.get("SUIT_BARCODE") or "G-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=7)),
        "SUIT_TYPE": p.get("SUIT_TYPE", "GOWN"), "SUIT_COLOR": p.get("SUIT_COLOR", "WHITE"),
        "SUIT_SIZE": p.get("SUIT_SIZE", "L"), "SUIT_LEVEL": p.get("SUIT_LEVEL", "FAB1"),
        "STATE": p.get("STATE", "EMPLOYEE GOWN ISSUE"), "INSERT_TIME": INSERT_TIME, "RECTIME": RECTIME,
        "VISIBLE_AT": p.get("VISIBLE_AT", RECTIME),
    }


def on_hand(garment: str, color: str, size: str, loc: str) -> int:
    with connect() as c:
        r = one(c, """SELECT si.on_hand FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
                        JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
                       WHERE g.code = ? AND c.name = ? AND s.code = ? AND l.code = ?""", [garment, color, size, loc])
    return r["on_hand"] if r else 0
