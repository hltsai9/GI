"""Real Oracle access (python-oracledb thin mode: no Oracle Client needed). Dates are read with TO_CHAR
so they arrive as naive strings and GI applies the time zones itself."""
from __future__ import annotations

from ..config import Config
from .source import ISSUE_STATE, InsertKey, OracleIssueRow, clean_barcode

_COLS = """SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL,
  TO_CHAR(INSERT_TIME, 'YYYY-MM-DD HH24:MI:SS') AS INSERT_TIME"""


def _d(bind: str) -> str:
    return f"TO_DATE(:{bind}, 'YYYY-MM-DD HH24:MI:SS')"


class OracleIssueSource:
    """Reads by INSERT_TIME only; an index on (STATE, INSERT_TIME) in Oracle keeps it fast (TODO with the DBA)."""

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
