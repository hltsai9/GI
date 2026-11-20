"""Real Oracle access (python-oracledb thin mode: no Oracle Client needed). Dates are read with TO_CHAR
so they arrive as naive strings and GI applies the time zones itself."""
from __future__ import annotations

from ..config import Config
from .source import ISSUE_STATE, InsertKey, OracleIssueRow, RectimeKey, clean_barcode

_COLS = """SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL,
  TO_CHAR(INSERT_TIME, 'YYYY-MM-DD HH24:MI:SS') AS INSERT_TIME,
  TO_CHAR(RECTIME, 'YYYY-MM-DD HH24:MI:SS') AS RECTIME"""


def _d(bind: str) -> str:
    return f"TO_DATE(:{bind}, 'YYYY-MM-DD HH24:MI:SS')"


# Keyset position on (RECTIME, SUIT_BARCODE), written so an index on (STATE, SUIT_LEVEL, RECTIME) is used.
_AFTER_KEY = f"RECTIME >= {_d('r1')} AND (RECTIME > {_d('r2')} OR SUIT_BARCODE > :bc)"


class OracleIssueSource:
    def __init__(self, cfg: Config):
        import oracledb  # imported here so mock-only installs never touch it

        self._pool = oracledb.create_pool(user=cfg.ORACLE_USER, password=cfg.ORACLE_PASSWORD,
                                          dsn=cfg.ORACLE_CONNECT_STRING, min=0, max=2)
        self._table = cfg.ORACLE_ISSUE_TABLE  # validated identifier (config.py)

    def _q(self, sql: str, binds: dict) -> list[OracleIssueRow]:
        with self._pool.acquire() as conn, conn.cursor() as cur:
            cur.execute(sql, binds)
            names = [d[0] for d in cur.description]
            out = [dict(zip(names, r)) for r in cur.fetchall()]
            for r in out:
                r["SUIT_BARCODE"] = clean_barcode(r["SUIT_BARCODE"] or "")
            return out  # type: ignore[return-value]

    def by_level(self, level: str, after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        return self._q(f"""SELECT {_COLS} FROM {self._table} WHERE STATE = :state AND SUIT_LEVEL = :lvl AND {_AFTER_KEY}
                           ORDER BY RECTIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY""",
                       {"state": ISSUE_STATE, "lvl": level, "r1": after["rectime"], "r2": after["rectime"], "bc": after["barcode"], "lim": limit})

    def other_levels(self, known: list[str], after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        binds: dict = {"state": ISSUE_STATE, "r1": after["rectime"], "r2": after["rectime"], "bc": after["barcode"], "lim": limit}
        binds.update({f"k{i}": k for i, k in enumerate(known)})
        not_in = f"AND SUIT_LEVEL NOT IN ({','.join(f':k{i}' for i in range(len(known)))})" if known else ""
        return self._q(f"""SELECT {_COLS} FROM {self._table} WHERE STATE = :state {not_in} AND {_AFTER_KEY}
                           ORDER BY RECTIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY""", binds)

    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        binds: dict = {"state": ISSUE_STATE, "fromT": start, "lim": limit}
        extra = ""
        if after:
            extra = f"AND (INSERT_TIME > {_d('aT')} OR (INSERT_TIME = {_d('aT2')} AND SUIT_BARCODE > :aB))"
            binds.update({"aT": after["insert_time"], "aT2": after["insert_time"], "aB": after["barcode"]})
        return self._q(f"""SELECT {_COLS} FROM {self._table} WHERE STATE = :state AND INSERT_TIME >= {_d('fromT')} {extra}
                           ORDER BY INSERT_TIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY""", binds)

    def close(self) -> None:
        self._pool.close(force=True)
