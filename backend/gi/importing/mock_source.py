"""Behaves like the Oracle issue table for the queries GI runs, including rows that only appear later
(records entered up to ~15 h after the scan) and RECTIME that is only in order within a location."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Callable

from ..config import config
from ..timeutil import now_utc, utc_to_local
from .source import ISSUE_STATE, InsertKey, OracleIssueRow, RectimeKey

_FIELDS = ("SUIT_BARCODE", "SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL", "INSERT_TIME", "RECTIME")


def _strip(rs: list[dict]) -> list[OracleIssueRow]:
    return [{k: r[k] for k in _FIELDS} for r in rs]  # type: ignore[misc]


def _after_key(r: dict, k: RectimeKey) -> bool:
    return r["RECTIME"] > k["rectime"] or (r["RECTIME"] == k["rectime"] and r["SUIT_BARCODE"] > k["barcode"])


class MockIssueSource:
    """Rows carry STATE and VISIBLE_AT (Phoenix time the row is committed; invisible before)."""

    def __init__(self, data: list[dict], now: Callable[[], datetime] = now_utc):
        self.data = data
        self.now = now

    @classmethod
    def from_dir(cls, directory: str | None = None) -> "MockIssueSource":
        """Reads issues.ndjson from MOCK_ORACLE_DIR if it exists; otherwise generates the rows in memory
        (45 days back, 2 ahead) and generates them again each new day, so a long-running server keeps
        finding new issues. The generator gives the same rows on every replica."""
        f = Path(directory or config.MOCK_ORACLE_DIR) / "issues.ndjson"
        if f.is_file():
            text = f.read_text(encoding="utf-8")
            return cls([json.loads(line) for line in text.splitlines() if line])
        return _GeneratedSource()

    def _visible(self) -> list[dict]:
        now_phx = utc_to_local(self.now(), config.ORACLE_RECTIME_ZONE)
        return [r for r in self.data if r["STATE"] == ISSUE_STATE and r["VISIBLE_AT"] <= now_phx]

    def by_level(self, level: str, after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        rs = [r for r in self._visible() if r["SUIT_LEVEL"] == level and _after_key(r, after)]
        return _strip(sorted(rs, key=lambda r: (r["RECTIME"], r["SUIT_BARCODE"]))[:limit])

    def other_levels(self, known: list[str], after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        rs = [r for r in self._visible() if r["SUIT_LEVEL"] not in known and _after_key(r, after)]
        return _strip(sorted(rs, key=lambda r: (r["RECTIME"], r["SUIT_BARCODE"]))[:limit])

    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        rs = [r for r in self._visible() if r["INSERT_TIME"] >= start and (
            after is None or r["INSERT_TIME"] > after["insert_time"]
            or (r["INSERT_TIME"] == after["insert_time"] and r["SUIT_BARCODE"] > after["barcode"]))]
        return _strip(sorted(rs, key=lambda r: (r["INSERT_TIME"], r["SUIT_BARCODE"]))[:limit])

    def close(self) -> None:
        pass


class _GeneratedSource(MockIssueSource):
    def __init__(self) -> None:
        super().__init__([])
        self._day: str | None = None

    def _visible(self) -> list[dict]:
        from ..mock_oracle import generate

        now = self.now()
        day = utc_to_local(now, config.ORACLE_RECTIME_ZONE)[:10]
        if day != self._day:
            self.data, _ = generate(now=now)
            self._day = day
        return super()._visible()
