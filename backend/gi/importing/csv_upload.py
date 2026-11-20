"""Import of issue rows from a CSV export of the Oracle issue table (Settings › Import), for environments
that cannot reach Oracle. The rows go through the same import as the Oracle connection, so a row whose
SUIT_BARCODE + INSERT_TIME is already in GI is skipped: uploading the same or an overlapping file
again adds nothing twice. Watermarks are not touched, so a later Oracle connection is unaffected.

The file is checked completely first; if any row is invalid, nothing is imported.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import datetime

from typing import Callable

from ..db import connect, execute
from ..timeutil import now_utc
from .importer import _Counters, _exclusive, _finish_run, _import_batch, _start_run
from .source import ISSUE_STATE, OracleIssueRow, clean_barcode

REQUIRED = ("SUIT_BARCODE", "SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL", "INSERT_TIME", "RECTIME")
MAX_ERRORS = 20
BATCH = 500  # rows per transaction; progress is saved after each batch

# Date-times as Oracle tools and the recommended export query write them. Seconds are required: the
# duplicate check compares INSERT_TIME to the second (a file saved by Excel often loses the seconds).
_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
    "%d-%b-%y %I:%M:%S %p", "%d-%b-%Y %I:%M:%S %p", "%d-%b-%y %H:%M:%S", "%d-%b-%Y %H:%M:%S",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %I:%M:%S %p",
)
# "09.00.00" (Oracle NLS) → "09:00:00"; drops fractional seconds ("09:00:00.000000").
# A long numeric barcode after a spreadsheet saved the file: "2.39960000264108E+15" (digits lost).
_SCIENTIFIC = re.compile(r"^\s*\d+(\.\d+)?[eE][+-]?\d+\s*$")
_TIME = re.compile(r"(?<!\d)(\d{1,2})[.:](\d{2})[.:](\d{2})(?:[.,]\d+)?(?!\d)")


class CsvError(ValueError):
    def __init__(self, message: str, problems: list[str] | None = None):
        super().__init__(message)
        self.problems = problems or []


def parse_time(value: str) -> str:
    """Returns 'YYYY-MM-DD HH:MM:SS' (the form GI stores, same as the Oracle connection's TO_CHAR)."""
    v = _TIME.sub(lambda m: f"{int(m[1]):02d}:{m[2]}:{m[3]}", value.strip())
    for f in _FORMATS:
        try:
            return datetime.strptime(v, f).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"unreadable date-time {value!r} (need date and time with seconds, e.g. 2026-11-20 09:15:30)")


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def parse(data: bytes) -> tuple[list[OracleIssueRow], int]:
    """Returns (issue rows, rows skipped because STATE is not an issue). Raises CsvError listing the problems."""
    text = _decode(data)
    if not text.strip():
        raise CsvError("The file is empty.")
    # The separator is taken from the header line (column names only, no messy data); quoting is always the
    # standard CSV rule ("" inside quotes is one "), which Oracle tools and Excel write. Guessing the quoting
    # from the data (csv.Sniffer) changed barcodes that contain a quote character.
    first = text.lstrip("\ufeff").split("\n", 1)[0]
    delimiter = max(",;\t|", key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quotechar='"', doublequote=True, skipinitialspace=False)
    header = next(reader, [])
    cols = {h.strip().strip('"').upper(): i for i, h in enumerate(header)}
    missing = [c for c in REQUIRED if c not in cols]
    if missing:
        raise CsvError(f"Missing column(s): {', '.join(missing)}. The first line must have the Oracle column names.",
                       [f"Columns found: {', '.join(h.strip() for h in header) or '(none)'}"])
    state_col = cols.get("STATE")
    out: list[OracleIssueRow] = []
    other_state = 0
    problems: list[str] = []
    bad = 0
    for line_no, rec in enumerate(reader, start=2):
        if not any(x.strip() for x in rec):
            continue  # blank line
        get = lambda c: rec[cols[c]].strip() if cols[c] < len(rec) else ""  # noqa: E731
        if state_col is not None and (rec[state_col].strip() if state_col < len(rec) else "") != ISSUE_STATE:
            other_state += 1
            continue
        try:
            empty = [c for c in REQUIRED if not get(c)]
            if empty:
                raise ValueError(f"empty {', '.join(empty)}")
            barcode = clean_barcode(rec[cols["SUIT_BARCODE"]] if cols["SUIT_BARCODE"] < len(rec) else "")
            if _SCIENTIFIC.match(barcode):
                raise ValueError(f"SUIT_BARCODE {barcode!r} is in scientific notation: the file was saved by Excel, which "
                                 "keeps only 15 digits. Upload the original export instead")
            if len(barcode) > 255:
                raise ValueError(f"SUIT_BARCODE is longer than 255 characters ({barcode[:40]!r}…)")
            # Trailing padding removed; leading and inner spaces kept, the same as the live Oracle import.
            out.append({"SUIT_BARCODE": barcode, "SUIT_TYPE": get("SUIT_TYPE"), "SUIT_COLOR": get("SUIT_COLOR"),
                        "SUIT_SIZE": get("SUIT_SIZE"), "SUIT_LEVEL": get("SUIT_LEVEL"),
                        "INSERT_TIME": parse_time(get("INSERT_TIME")), "RECTIME": parse_time(get("RECTIME"))})
        except ValueError as e:
            bad += 1
            if len(problems) < MAX_ERRORS:
                problems.append(f"Line {line_no}: {e}")
    if bad:
        raise CsvError(f"{bad} row(s) could not be read; nothing was imported. Fix the file and upload it again.", problems)
    if not out:
        raise CsvError("The file has no rows with STATE = 'EMPLOYEE GOWN ISSUE'." if other_state else "The file has no data rows.")
    return out, other_state


def import_rows(rows: list[OracleIssueRow], other_state: int, file_name: str = "",
                on_started: Callable[[int], None] | None = None) -> dict:
    """Imports parsed rows in one run (kind 'upload'), saving progress in sync_run after each batch so any
    replica can report it. Rows already in GI are skipped."""
    now = now_utc()

    def run() -> dict:
        run_id = _start_run("upload", note=(file_name or "")[:255] or None)
        with connect() as conn:
            execute(conn, "UPDATE sync_run SET rows_total = ?, rows_other_state = ? WHERE id = ?", [len(rows), other_state, run_id])
        if on_started:
            on_started(run_id)
        c = _Counters()
        try:
            for i in range(0, len(rows), BATCH):
                _import_batch(rows[i:i + BATCH], run_id, c, now)
                with connect() as conn:
                    execute(conn, "UPDATE sync_run SET rows_read = ?, rows_new = ? WHERE id = ?", [c.read, c.new, run_id])
            result = _finish_run(run_id, "upload", c)
        except Exception as e:  # noqa: BLE001
            _finish_run(run_id, "upload", c, e)
            raise
        return {**result, "fileRows": len(rows) + other_state, "alreadyImported": c.read - c.new, "otherState": other_state}

    return _exclusive(run)


def import_csv(data: bytes, file_name: str = "") -> dict:
    """Parses and imports a file, waiting until it is done (used by tests and scripts)."""
    rows, other_state = parse(data)
    return import_rows(rows, other_state, file_name)


def run_progress(run: dict) -> dict:
    """An upload run as the page shows it: progress while running, the counts when finished."""
    total = run.get("rows_total") or 0
    other = run.get("rows_other_state") or 0
    return {
        "runId": run["id"], "status": run["status"], "fileName": run.get("note"),
        "total": total, "done": run["rows_read"], "new": run["rows_new"],
        "alreadyImported": run["rows_read"] - run["rows_new"], "otherState": other, "fileRows": total + other,
        "byStatus": {"applied": run["rows_applied"], "held_unmapped": run["rows_held"],
                     "before_start": run["rows_before_start"], "ignored": run["rows_ignored"]},
        "error": (run.get("error") or "").strip().splitlines()[-1] if run.get("error") else None,
    }
