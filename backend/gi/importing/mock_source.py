"""Behaves like the Oracle issue table for the query GI runs (by INSERT_TIME), including rows that only appear
later: records reach the database up to ~15 h after the scan (VISIBLE_AT, mock only)."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Callable

from ..config import config
from ..timeutil import now_utc, utc_to_local
from .source import ISSUE_STATE, InsertKey, MasterRow, OracleIssueRow

_FIELDS = ("SUIT_BARCODE", "SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL", "INSERT_TIME")


def _master(m: dict) -> MasterRow:
    return {k: m.get(k) for k in ("SUIT_BARCODE", "SUIT_CATEGORY", "SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "RECTIME")}  # type: ignore[return-value]


def _strip(rs: list[dict]) -> list[OracleIssueRow]:
    return [{k: r[k] for k in _FIELDS} for r in rs]  # type: ignore[misc]


class MockIssueSource:
    """Rows carry STATE and VISIBLE_AT (Phoenix time the row reaches the database; invisible before)."""

    def __init__(self, data: list[dict], now: Callable[[], datetime] = now_utc, master: list[dict] | None = None):
        self.data = data
        self.now = now
        self.master = master or []  # barcode master rows (several per barcode for re-labelled garments)

    @classmethod
    def from_dir(cls, directory: str | None = None) -> "MockIssueSource":
        """Reads issues.ndjson from MOCK_ORACLE_DIR if it exists; otherwise generates the rows in memory
        (45 days back, 2 ahead) and generates them again each new day, so a long-running server keeps
        finding new issues. The generator gives the same rows on every replica."""
        d = Path(directory or config.MOCK_ORACLE_DIR)
        f = d / "issues.ndjson"
        if f.is_file():
            read = lambda p: [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line]  # noqa: E731
            m = d / "barcode_master.ndjson"
            return cls(read(f), master=read(m) if m.is_file() else [])
        return _GeneratedSource()

    def _visible(self) -> list[dict]:
        now_phx = utc_to_local(self.now(), config.SITE_TIMEZONE)
        return [r for r in self.data if r["STATE"] == ISSUE_STATE and r.get("VISIBLE_AT", r["INSERT_TIME"]) <= now_phx]

    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        rs = [r for r in self._visible() if r["INSERT_TIME"] >= start and (
            after is None or r["INSERT_TIME"] > after["insert_time"]
            or (r["INSERT_TIME"] == after["insert_time"] and r["SUIT_BARCODE"] > after["barcode"]))]
        return _strip(sorted(rs, key=lambda r: (r["INSERT_TIME"], r["SUIT_BARCODE"]))[:limit])

    def _master_rows(self) -> list[dict]:
        return self.master

    def master_page(self, after: str | None, limit: int, since: str | None = None) -> list[MasterRow]:
        rs = sorted((m for m in self._master_rows() if (after is None or m["SUIT_BARCODE"] > after)
                     and (since is None or (m.get("RECTIME") or "") >= since)),
                    key=lambda m: (m["SUIT_BARCODE"], m["RECTIME"]))
        return [_master(m) for m in rs[:limit]]

    def master_for(self, barcodes: list[str]) -> list[MasterRow]:
        want = set(barcodes)
        return [_master(m) for m in self._master_rows() if m["SUIT_BARCODE"] in want]

    def close(self) -> None:
        pass


class _GeneratedSource(MockIssueSource):
    def __init__(self) -> None:
        super().__init__([])
        self._day: str | None = None

    def _visible(self) -> list[dict]:
        from ..mock_oracle import generate

        now = self.now()
        day = utc_to_local(now, config.SITE_TIMEZONE)[:10]
        if day != self._day:
            self.data, self.master = generate(now=now)
            self._day = day
        return super()._visible()

    def _master_rows(self) -> list[dict]:
        self._visible()  # generates the day's data, master included
        return self.master
