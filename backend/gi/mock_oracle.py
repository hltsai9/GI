"""Mock Oracle issue data that behaves like the real issuing system:
- one row per garment issued; STATE = 'EMPLOYEE GOWN ISSUE' (plus other states to filter out)
- INSERT_TIME = scan time in Taipei time; RECTIME = entry time in Phoenix time, 0–15 h later
- records are entered in batches per location, so RECTIME is ordered within a location only;
  Fab2's batches become visible up to 40 min after their RECTIME (out of order across locations)
- ~3 % of barcodes are not registered in the suit master → reported as GOWN / OTHER / OTHER
- a new size code "5XL" (unmapped), a "TEST" location (ignored), and now and then a row with a bad clock

Deterministic per calendar day: the rows for a given day are identical whenever and wherever they are
generated, so several replicas (each generating its own copy) import the same data.

Usage: python -m gi.mock_oracle [--days 45] [--ahead 2] [--out mock-oracle-data]
Without files, the mock source generates the same rows in memory (see importing/mock_source.py).
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

PHX = ZoneInfo("America/Phoenix")
TPE = ZoneInfo("Asia/Taipei")
FMT = "%Y-%m-%d %H:%M:%S"
_M = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M


def rng(seed: str) -> Callable[[], float]:
    """Deterministic random numbers from a text seed (FNV-1a hash → mulberry32)."""
    h = 2166136261
    for ch in seed:
        h = _imul(h ^ ord(ch), 16777619)
    state = [h & _M]

    def next_() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & _M
        t = state[0]
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _M
        return ((t ^ (t >> 14)) & _M) / 4294967296

    return next_


def _pick(rand: Callable[[], float], items: list[tuple]) -> object:
    total = sum(w for _, w in items)
    x = rand() * total
    for v, w in items:
        x -= w
        if x <= 0:
            return v
    return items[-1][0]


TYPES = ("GOWN", "HOOD", "BOOT")
COLORS = [("WHITE", 70), ("BLUE", 22), ("BLACK", 7), ("OTHER", 1)]
SIZES = [("S", 8), ("M", 22), ("L", 30), ("XL", 22), ("2XL", 10), ("3XL", 4), ("4XL", 2), ("5XL", 0.3)]
LEVELS = [("FAB1", 140), ("FAB2", 85), ("TEST", 2)]
COLOR_CODE = {"WHITE": "WH", "BLUE": "BU", "BLACK": "BK", "OTHER": "OT"}  # unique per color


@dataclass
class Garment:
    barcode: str
    type: str
    color: str
    size: str
    registered: bool


class _Generator:
    def __init__(self) -> None:
        self.garments: dict[str, Garment] = {}
        self.batch_cache: dict[str, list[datetime]] = {}

    def garment(self, gtype: str, color: str, size: str, rand: Callable[[], float]) -> Garment:
        """Each type × color × size has a fixed pool of 40 garments; a barcode always means the same garment."""
        barcode = f"{gtype[0]}-{COLOR_CODE[color]}{size.rjust(3, '0')}-{int(rand() * 40):03d}"
        g = self.garments.get(barcode)
        if g is None:
            g = Garment(barcode, gtype, color, size, rng(f"registered|{barcode}")() > 0.03)
            self.garments[barcode] = g
        return g

    def batches(self, level: str, day: datetime) -> list[datetime]:
        """Times records are entered for a location on a Phoenix day: every 1–4 h."""
        key = f"{level}|{day.date().isoformat()}"
        if key not in self.batch_cache:
            rand = rng(f"batches|{key}")
            times = []
            t = day + timedelta(minutes=20 + int(rand() * 100))
            while t < day + timedelta(days=1):
                times.append(t)
                t += timedelta(minutes=60 + int(rand() * 180))
            self.batch_cache[key] = times
        return self.batch_cache[key]

    def entered_at(self, level: str, at: datetime, rand: Callable[[], float]) -> datetime:
        day = at.replace(hour=0, minute=0, second=0, microsecond=0)
        nxt = [t for t in self.batches(level, day) + self.batches(level, day + timedelta(days=1)) if t > at]
        # Usually the next batch; sometimes one or more are skipped and the row waits for a later one.
        skip = int(rand() * 4) if rand() < 0.25 else 0
        t = nxt[min(skip, len(nxt) - 1)]
        return at + timedelta(hours=14 + rand()) if (t - at) > timedelta(hours=15) else t


def generate(days: int = 45, ahead: int = 2, now: datetime | None = None) -> tuple[list[dict], list[dict]]:
    """Returns (issue table rows incl. STATE and VISIBLE_AT, suit master rows)."""
    g = _Generator()
    rows: list[dict] = []
    today = (now or datetime.now(PHX)).astimezone(PHX).replace(hour=0, minute=0, second=0, microsecond=0)
    for d in range(-days, ahead + 1):
        day = today + timedelta(days=d)
        iso = day.date().isoformat()
        weekend = day.isoweekday() >= 6
        epoch_day = round(day.timestamp() / 86400)
        for level, people in LEVELS:
            rand = rng(f"scans|{level}|{iso}")
            n = round(people * (0.55 if weekend else 1) * (0.85 + rand() * 0.3))
            for _ in range(n):
                # Gowning peaks at Phoenix shift starts: 06:00, 14:00, 22:00
                shift = _pick(rand, [(6, 50), (14, 35), (22, 15)])
                start = day + timedelta(hours=shift, minutes=int(rand() * 75) - 15, seconds=int(rand() * 60))  # type: ignore[arg-type]
                color = _pick(rand, COLORS)
                size = _pick(rand, SIZES)
                scans = []
                for i, gtype in enumerate(TYPES):
                    if gtype == "HOOD" and rand() < 0.05:
                        continue  # some people reuse a hood
                    scans.append((start + timedelta(seconds=i * 7 + int(rand() * 5)), g.garment(gtype, color, size, rand), "EMPLOYEE GOWN ISSUE"))  # type: ignore[arg-type]
                if rand() < 0.3:
                    scans.append((start + timedelta(hours=8), g.garment("GOWN", color, size, rand), "EMPLOYEE GOWN RETURN"))  # type: ignore[arg-type]
                for at, gm, state in scans:
                    r2 = rng(f"entry|{gm.barcode}|{at.isoformat()}")
                    entered = g.entered_at(level, at, r2) + timedelta(seconds=int(r2() * 50))
                    visible = entered + timedelta(minutes=int(r2() * 40)) if level == "FAB2" else entered
                    rows.append({
                        "SUIT_BARCODE": gm.barcode,
                        "SUIT_TYPE": gm.type if gm.registered else "GOWN",
                        "SUIT_COLOR": gm.color if gm.registered else "OTHER",
                        "SUIT_SIZE": gm.size if gm.registered else "OTHER",
                        "SUIT_LEVEL": level,
                        "INSERT_TIME": at.astimezone(TPE).strftime(FMT),
                        "RECTIME": entered.strftime(FMT),
                        "STATE": state,
                        "VISIBLE_AT": visible.strftime(FMT),
                    })
            # Every 30th day, one FAB1 row has a bad clock: RECTIME ~150 h before the scan (ORA-13).
            if level == "FAB1" and epoch_day % 30 == 0:
                day_tpe = day.astimezone(TPE).strftime(FMT)
                bad = next((r for r in rows if r["SUIT_LEVEL"] == "FAB1" and r["STATE"] == "EMPLOYEE GOWN ISSUE"
                            and r["INSERT_TIME"] >= day_tpe), None)
                if bad:
                    bad["RECTIME"] = (datetime.strptime(bad["RECTIME"], FMT) - timedelta(hours=150)).strftime(FMT)
    # Keep unique (SUIT_BARCODE, INSERT_TIME), as in Oracle.
    seen: set[str] = set()
    unique = []
    for r in rows:
        k = r["SUIT_BARCODE"] + r["INSERT_TIME"]
        if k not in seen:
            seen.add(k)
            unique.append(r)
    master = [{"SUIT_BARCODE": x.barcode, "SUIT_CATEGORY": "CLEANROOM", "SUIT_TYPE": x.type, "SUIT_COLOR": x.color,
               "SUIT_SIZE": x.size} for x in g.garments.values() if x.registered]
    return unique, master


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Write mock Oracle issue data (ndjson).")
    p.add_argument("--days", type=int, default=45)
    p.add_argument("--ahead", type=int, default=2, help="rows scanned 'in the future' become visible as time passes")
    p.add_argument("--out", default="mock-oracle-data")
    a = p.parse_args(argv)
    issues, master = generate(a.days, a.ahead)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "issues.ndjson").write_text("".join(json.dumps(r) + "\n" for r in issues), encoding="utf-8")
    (out / "suit_master.ndjson").write_text("".join(json.dumps(r) + "\n" for r in master), encoding="utf-8")
    real = [r for r in issues if r["STATE"] == "EMPLOYEE GOWN ISSUE"]
    unreg = sum(1 for r in real if r["SUIT_COLOR"] == "OTHER" and r["SUIT_SIZE"] == "OTHER")
    print(f"wrote {len(issues)} rows ({len(real)} issues, {unreg} unregistered) and {len(master)} registered barcodes to {out}")


if __name__ == "__main__":
    main()
