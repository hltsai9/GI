import pytest
from conftest import on_hand, ref_ids, user_id
from fastapi.testclient import TestClient

from gi.config import config
from gi.db import connect, one, rows
from gi.importing.csv_upload import CsvError, import_csv, parse, parse_time
from gi.services.counts import StartingCountInput, save_starting_count

HEADER = "SUIT_BARCODE,SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL,INOUT_CATEGORY,INOUT_ACTION,STATE,EMPLOYEE_ID,INSERT_TIME,INSERT_USER,RECTIME\n"


def line(barcode, insert_time, rectime, state="EMPLOYEE GOWN ISSUE", size="L", level="FAB1"):
    return f"{barcode},GOWN,WHITE,{size},{level},X,Y,{state},E1,{insert_time},U1,{rectime}\n"


def count() -> int:
    with connect() as c:
        return one(c, "SELECT COUNT(*) AS n FROM issue_import")["n"]  # type: ignore[index]


@pytest.mark.parametrize("value", [
    "2026-11-20 09:05:07", "2026/11/20 09:05:07", "2026-11-20T09:05:07", "20-NOV-26 09.05.07 AM", "20-Nov-2026 09:05:07",
    "11/20/2026 09:05:07", "11/20/2026 9:05:07 AM", "20-NOV-26 09.05.07.000000 AM", "2026-11-20 09:05:07.0",
])
def test_reads_common_oracle_date_formats(value):
    assert parse_time(value) == "2026-11-20 09:05:07"


@pytest.mark.parametrize("value", ["2026-11-20", "11/20/2026 09:05", "20/11/2026 09:05:07", "soon"])
def test_refuses_dates_without_time_or_seconds(value):
    with pytest.raises(ValueError):
        parse_time(value)


def test_keeps_only_issue_rows_and_reads_semicolons():
    text = (HEADER + line("G-1", "2026-11-20 09:00:00", "2026-11-19 18:30:00")
            + line("G-2", "2026-11-20 09:00:00", "2026-11-19 18:30:00", state="EMPLOYEE GOWN RETURN")).replace(",", ";")
    got, other = parse(text.encode("utf-8-sig"))
    assert [r["SUIT_BARCODE"] for r in got] == ["G-1"] and other == 1


def test_rejects_the_whole_file_when_a_row_is_bad():
    data = (HEADER + line("G-1", "2026-11-20 09:00:00", "2026-11-19 18:30:00") + line("G-2", "2026-11-20", "2026-11-19 18:30:00")).encode()
    with pytest.raises(CsvError) as e:
        parse(data)
    assert "nothing was imported" in str(e.value) and e.value.problems[0].startswith("Line 3:")


def test_missing_columns_are_named():
    with pytest.raises(CsvError, match="RECTIME"):
        parse(b"SUIT_BARCODE,SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL,INSERT_TIME\nG-1,GOWN,WHITE,L,FAB1,2026-11-20 09:00:00\n")


@pytest.mark.usefixtures("fresh_db")
def test_rows_already_in_gi_are_not_imported_again():
    ids = ref_ids()
    save_starting_count(StartingCountInput(locationId=ids["loc"]["Fab1"], asOf="2026-11-01T00:00:00Z", counts=[]), user_id())
    first = HEADER + line("G-1", "2026-11-20 09:00:00", "2026-11-19 18:30:00") + line("G-2", "2026-11-20 10:00:00", "2026-11-19 19:30:00")
    r = import_csv(first.encode(), "export-1.csv")
    assert (r["new"], r["alreadyImported"]) == (2, 0)
    assert on_hand("GOWN", "White", "LG", "Fab1") == -2
    # The same file again: nothing new, stock unchanged.
    r = import_csv(first.encode(), "export-1.csv")
    assert (r["new"], r["alreadyImported"]) == (0, 2)
    # An overlapping file in another date format (Oracle NLS), with one new row and a duplicate line.
    second = (HEADER + line("G-2", "20-NOV-26 10.00.00 AM", "19-NOV-26 07.30.00 PM") + line("G-3", "20-NOV-26 11.00.00 AM", "19-NOV-26 08.30.00 PM")
              + line("G-3", "20-NOV-26 11.00.00 AM", "19-NOV-26 08.30.00 PM"))
    r = import_csv(second.encode(), "export-2.csv")
    assert (r["new"], r["alreadyImported"]) == (1, 2)
    assert count() == 3
    assert on_hand("GOWN", "White", "LG", "Fab1") == -3
    with connect() as c:
        runs = rows(c, "SELECT kind, note, rows_new FROM sync_run ORDER BY id")
        assert one(c, "SELECT COUNT(*) AS n FROM sync_watermark")["n"] == 0  # type: ignore[index]
    assert runs[-1] == {"kind": "upload", "note": "export-2.csv", "rows_new": 1}


@pytest.mark.usefixtures("fresh_db")
def test_upload_endpoint(monkeypatch):
    from gi.app import build_app
    monkeypatch.setattr(config, "ISSUE_SOURCE", "csv")
    c = TestClient(build_app())
    data = (HEADER + line("G-9", "2026-11-20 09:00:00", "2026-11-19 18:30:00")).encode()
    h = {"x-dev-user": "dev-admin", "content-type": "text/csv", "x-file-name": "issues%20nov.csv"}
    r = c.post("/api/sync/upload", content=data, headers=h)
    assert r.status_code == 200 and r.json()["new"] == 1
    assert c.post("/api/sync/upload", content=data, headers=h).json()["alreadyImported"] == 1
    bad = c.post("/api/sync/upload", content=b"a,b\n1,2\n", headers=h)
    assert bad.status_code == 400 and "Missing column" in bad.json()["error"]
    assert c.post("/api/sync/upload", content=data, headers={**h, "x-dev-user": "dev-floor"}).status_code == 403
    assert c.post("/api/sync/run", headers=h).status_code == 409  # no automatic source
    s = c.get("/api/sync/status", headers=h).json()
    assert s["stale"] is False and s["source"] == "csv"
    run = c.get("/api/sync/runs", headers=h).json()[0]
    assert run["kind"] == "upload" and run["note"] == "issues nov.csv"
