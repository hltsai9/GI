"""Barcode master: the attributes (type, color, size) of each barcode, from the Oracle barcode master table
(setting ORACLE_BARCODE_MASTER_TABLE, read in full once a day) or from CSV uploads (Settings › Import).

The Oracle table can hold several rows per barcode, because a barcode's attributes are corrected by adding a row.
GI keeps only the latest version (highest RECTIME) in barcode_master. The issue import uses it for two things:
- several issue rows for the same scan (SUIT_BARCODE + INSERT_TIME) with other values (the issue table repeats a
  scan once per master row): the row whose type, color and size match the barcode master is kept;
- an issue row with an empty type, color or size: the empty values are filled from the barcode master.
When the barcode master cannot decide (barcode not in it, or no row matches), the scan is held until it can.
RECTIME is only compared with other RECTIMEs of the same table, so its time zone does not matter."""
from __future__ import annotations

import csv
import io
import json
from typing import Iterable, Iterator

from sqlalchemy.engine import Connection

from ..db import execute, marks, rows
from ..timeutil import naive_str
from .source import MasterRow, clean_barcode, clean_value, same_all

# A version of a scan: (SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL); None = empty in Oracle.
Version = tuple[str | None, str | None, str | None, str | None]
Attrs = tuple[str | None, str | None, str | None]  # type, color, size from the barcode master
VALUE_COLUMNS = ("SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL")
_CHUNK = 500


def _when(rectime: str | None) -> str:
    """RECTIME for comparing: a row without RECTIME counts as older than any dated row."""
    return rectime or ""


def latest_versions(master_rows: Iterable[MasterRow]) -> dict[str, dict]:
    """Per barcode, the version with the latest RECTIME (a row without RECTIME counts as the oldest). Rows with the
    same values count once (capitals and spaces do not matter: "White" is "WHITE"). `alts` lists the different (type, color, size) at the latest RECTIME; more than one
    means `tied`: GI cannot tell which is current."""
    out: dict[str, dict] = {}
    for r in master_rows:
        b = r["SUIT_BARCODE"]
        vals = (r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"])
        cur = out.get(b)
        if cur is None or _when(r["RECTIME"]) > _when(cur["rectime"]):
            out[b] = {"category": r.get("SUIT_CATEGORY"), "attrs": vals, "rectime": r["RECTIME"],
                      "versions": (cur["versions"] if cur else 0) + 1, "alts": [vals], "tied": False}
        else:
            cur["versions"] += 1
            if _when(r["RECTIME"]) == _when(cur["rectime"]) and not _has(cur["alts"], vals):
                cur["alts"].append(vals)
                cur["tied"] = True
    return out


def _has(alts: list, vals: Attrs) -> bool:
    return any(same_all(a) == same_all(vals) for a in alts)


def alts_of(e: dict) -> list[Attrs]:
    """The different versions stored for a barcode (one when not tied); same values in other capitals count once."""
    stored = (e["suit_type"], e["suit_color"], e["suit_size"])
    raw = e.get("tie_values")
    out: list = []
    for a in [tuple(a) for a in (json.loads(raw) if isinstance(raw, str) else raw or [])] or [stored]:
        if not _has(out, a):
            out.append(a)
    return out


def store(conn: Connection, latest: dict[str, dict]) -> int:
    """Merges latest versions into barcode_master: one replaces the stored version when its RECTIME is later; at
    the same RECTIME the different versions are combined (identical ones count once), and more than one makes the
    barcode `tied` with every version kept in tie_values. So uploading an older export, or the same rows again
    (split files that overlap), never undoes or doubles anything. Returns how many barcodes changed."""
    changed = 0
    items = list(latest.items())
    for i in range(0, len(items), _CHUNK):
        chunk = items[i:i + _CHUNK]
        have = {r["suit_barcode"]: r for r in rows(conn, f"""SELECT suit_barcode, suit_type, suit_color, suit_size, rectime, tied, tie_values
                                                              FROM barcode_master WHERE suit_barcode IN ({marks(len(chunk))})""",
                                                    [b for b, _ in chunk])}
        values: list = []
        n = 0
        for b, v in chunk:
            e = have.get(b)
            attrs, alts = v["attrs"], list(v["alts"])
            if e:
                rt = naive_str(e["rectime"]) if e["rectime"] else ""
                if _when(v["rectime"]) < rt:
                    continue
                if _when(v["rectime"]) == rt:
                    old = alts_of(e)
                    merged = old + [a for a in alts if not _has(old, a)]
                    if len(merged) == len(old) and bool(e["tied"]) == (len(old) > 1):
                        continue  # nothing new at this RECTIME
                    attrs, alts = (e["suit_type"], e["suit_color"], e["suit_size"]), merged
            tied = len(alts) > 1
            values += [b, v["category"], *attrs, v["rectime"], v["versions"], tied, json.dumps([list(a) for a in alts]) if tied else None]
            n += 1
        if n:
            execute(conn, f"""INSERT INTO barcode_master (suit_barcode, suit_category, suit_type, suit_color, suit_size, rectime, versions, tied, tie_values)
                              VALUES {', '.join(['(?,?,?,?,?,?,?,?,?)'] * n)}
                              ON DUPLICATE KEY UPDATE suit_category = VALUES(suit_category), suit_type = VALUES(suit_type),
                                suit_color = VALUES(suit_color), suit_size = VALUES(suit_size), rectime = VALUES(rectime),
                                versions = VALUES(versions), tied = VALUES(tied), tie_values = VALUES(tie_values)""", values)
            changed += n
    return changed


def ties(conn: Connection, limit: int | None = None) -> list[dict]:
    """Barcodes whose rows at the latest RECTIME disagree (type, color or size), with every version: GI does not
    use them until a newer row settles it. For the data quality page and its CSV."""
    rs = rows(conn, f"""SELECT suit_barcode, suit_type, suit_color, suit_size, rectime, tie_values FROM barcode_master WHERE tied
                         ORDER BY rectime DESC, suit_barcode {'LIMIT ' + str(int(limit)) if limit else ''}""")
    return [{"barcode": r["suit_barcode"], "rectime": naive_str(r["rectime"]) if r["rectime"] else None,
             "versions": [{"type": a[0] or "", "color": a[1] or "", "size": a[2] or ""} for a in alts_of(r)]} for r in rs]


def attrs_for(conn: Connection, barcodes: Iterable[str]) -> dict[str, Attrs]:
    """The barcode master's current type, color and size of these barcodes (tied ones left out)."""
    bs = sorted(set(barcodes))
    out: dict[str, Attrs] = {}
    for i in range(0, len(bs), _CHUNK):
        chunk = bs[i:i + _CHUNK]
        for r in rows(conn, f"""SELECT suit_barcode, suit_type, suit_color, suit_size FROM barcode_master
                                 WHERE NOT tied AND suit_barcode IN ({marks(len(chunk))})""", chunk):
            out[r["suit_barcode"]] = (r["suit_type"], r["suit_color"], r["suit_size"])
    return out


def choose(versions: list[Version], m: Attrs | None) -> tuple[int, Version, str | None]:
    """Decides one scan. Returns (index of the version kept, that version with empty type / color / size filled
    from the barcode master, conflict state): None = only one version; 'resolved' = several versions, the one
    matching the barcode master kept; 'pending' = several versions and the barcode master cannot decide yet."""
    def fill(v: Version) -> Version:
        return v if m is None else (v[0] or m[0], v[1] or m[1], v[2] or m[2], v[3])

    if len(versions) == 1:
        return 0, fill(versions[0]), None
    if m is not None:
        for i, v in enumerate(versions):
            f = fill(v)
            if same_all(f[:3]) == same_all(m):
                return i, f, "resolved"
    return 0, fill(versions[0]), "pending"


def missing_of(v: Version) -> str | None:
    """The columns empty in an Oracle row, as stored in issue_import.missing_values."""
    return ",".join(c for c, x in zip(VALUE_COLUMNS, v) if x is None) or None


# ---- reading the Oracle table (daily) and CSV uploads, one batch at a time (memory stays small)
def read_pages(source, page_size: int, since: str | None = None) -> Iterator[list[MasterRow]]:
    """The barcode master table page by page, keyset-paged on SUIT_BARCODE: every row, or with `since` only rows
    with RECTIME at or after it (the daily read). A page never splits a barcode's rows: a full page drops its
    last barcode, which the next page starts with."""
    after: str | None = None
    while True:
        page = source.master_page(after, page_size, since)
        full = len(page) >= page_size
        if full:
            last = page[-1]["SUIT_BARCODE"]
            page = [r for r in page if r["SUIT_BARCODE"] != last] or page  # one barcode with more rows than a page: as they are
        if page:
            yield page
        if not full:
            return
        after = page[-1]["SUIT_BARCODE"]


REQUIRED = ("SUIT_BARCODE", "SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "RECTIME")  # SUIT_CATEGORY optional; REC_USER … ignored
# An empty RECTIME cell is allowed: that row counts as the oldest version of its barcode.


def _csv_rows(data: bytes) -> Iterator[tuple[int, MasterRow | None, str | None]]:
    """(line number, row, problem) for each data line of a barcode master export, read as a stream."""
    from .csv_upload import CsvError, _decode, _SCIENTIFIC, parse_time

    text = _decode(data)
    if not text.strip():
        raise CsvError("The file is empty.")
    first = text.lstrip("\ufeff").split("\n", 1)[0]
    delimiter = max(",;\t|", key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quotechar='"', doublequote=True)
    header = next(reader, [])
    cols = {h.strip().strip('"').upper(): i for i, h in enumerate(header)}
    missing = [c for c in REQUIRED if c not in cols]
    if missing:
        raise CsvError(f"Missing column(s): {', '.join(missing)}. The first line must have the barcode master's column names.",
                       [f"Columns found: {', '.join(h.strip() for h in header) or '(none)'}"])
    for line_no, rec in enumerate(reader, start=2):
        if not any(x.strip() for x in rec):
            continue
        get = lambda c: rec[cols[c]] if c in cols and cols[c] < len(rec) else ""  # noqa: E731
        try:
            barcode = clean_barcode(get("SUIT_BARCODE"))
            if not barcode.strip():
                raise ValueError("empty SUIT_BARCODE")
            if _SCIENTIFIC.match(barcode):
                raise ValueError(f"SUIT_BARCODE {barcode!r} is in scientific notation: the file was saved by Excel. "
                                 "Upload the original export instead")
            if len(barcode) > 255:
                raise ValueError("SUIT_BARCODE is longer than 255 characters")
            yield line_no, {"SUIT_BARCODE": barcode, "SUIT_CATEGORY": clean_value(get("SUIT_CATEGORY").strip()),
                            "SUIT_TYPE": clean_value(get("SUIT_TYPE").strip()), "SUIT_COLOR": clean_value(get("SUIT_COLOR").strip()),
                            "SUIT_SIZE": clean_value(get("SUIT_SIZE").strip()),
                            "RECTIME": parse_time(get("RECTIME")) if get("RECTIME").strip() else None}, None
        except ValueError as e:
            yield line_no, None, str(e)


def check_csv(data: bytes) -> int:
    """Checks a whole barcode master export without keeping its rows. Returns the number of rows; raises CsvError
    listing the problems (then nothing is saved)."""
    from .csv_upload import MAX_ERRORS, CsvError

    n, bad, problems = 0, 0, []
    for line_no, row, problem in _csv_rows(data):
        if problem:
            bad += 1
            if len(problems) < MAX_ERRORS:
                problems.append(f"Line {line_no}: {problem}")
        else:
            n += 1
    if bad:
        raise CsvError(f"{bad} row(s) could not be read; nothing was saved. Fix the file and upload it again.", problems)
    if not n:
        raise CsvError("The file has no data rows.")
    return n


def csv_batches(data: bytes, size: int = 2000) -> Iterator[list[MasterRow]]:
    """The rows of a checked export, `size` at a time."""
    batch: list[MasterRow] = []
    for _, row, _ in _csv_rows(data):
        if row:
            batch.append(row)
            if len(batch) >= size:
                yield batch
                batch = []
    if batch:
        yield batch


def parse_csv(data: bytes) -> list[MasterRow]:
    """All rows of a (small) export, after checking it; used by tests and scripts."""
    check_csv(data)
    return [r for b in csv_batches(data) for r in b]


def newest_rectime(conn: Connection) -> str | None:
    """The newest RECTIME in GI's copy: the daily read takes rows from there on (minus a look-back)."""
    r = rows(conn, "SELECT MAX(rectime) AS t FROM barcode_master")[0]
    return naive_str(r["t"]) if r["t"] else None


def summary(conn: Connection) -> dict:
    """Barcode master figures for Settings › Import."""
    m = rows(conn, "SELECT COUNT(*) AS n, COALESCE(SUM(tied), 0) AS tied, MAX(updated_at) AS at FROM barcode_master")[0]
    w = rows(conn, """SELECT COALESCE(SUM(status = 'held_conflict'), 0) AS conflict, COALESCE(SUM(status = 'held_missing'), 0) AS missing
                        FROM issue_import WHERE status IN ('held_conflict', 'held_missing')""")[0]
    last = rows(conn, """SELECT id, kind, note, started_at, finished_at, rows_read, rows_total, rows_new, rows_resolved, status, error FROM sync_run
                          WHERE kind IN ('master', 'master_upload') ORDER BY id DESC LIMIT 1""")
    return {"barcodes": int(m["n"]), "tied": int(m["tied"]), "updatedAt": m["at"], "newestRectime": newest_rectime(conn),
            "waiting": {"conflict": int(w["conflict"]), "missing": int(w["missing"])}, "last": last[0] if last else None}
