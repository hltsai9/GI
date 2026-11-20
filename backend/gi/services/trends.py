from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.engine import Connection

from ..config import config
from ..db import rows
from ..timeutil import day_str, from_db, now_utc, site_day


def day_range(days: int, now: datetime | None = None) -> list[str]:
    """Inclusive list of site-time days ending today."""
    end = (now or now_utc()).astimezone(ZoneInfo(config.SITE_TIMEZONE)).date()
    return [(end - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


def _bucket(day: str, per: str) -> str:
    if per == "week":
        d = date.fromisoformat(day)
        return (d - timedelta(days=d.weekday())).isoformat()  # Monday
    if per == "month":
        return day[:7]
    return day


def _types(conn: Connection, include_system: bool) -> list[dict]:
    return rows(conn, f"SELECT id, name, is_system FROM garment_type WHERE active {'' if include_system else 'AND NOT is_system'} ORDER BY sort")


def _locations(conn: Connection) -> list[dict]:
    return rows(conn, "SELECT id, code FROM location ORDER BY id")


def delivered(conn: Connection, days: int, per: str, now: datetime | None = None) -> dict:
    """TRD-01: items delivered per day / week / month, by garment type; byLocation splits each total."""
    rng = day_range(days, now)
    rs = rows(conn, """SELECT d.received_day AS day, si.garment_type_id AS type_id, si.location_id, SUM(dl.qty_current) AS n
                         FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id JOIN stock_item si ON si.id = dl.stock_item_id
                        WHERE d.received_day BETWEEN ? AND ? GROUP BY d.received_day, si.garment_type_id, si.location_id""", [rng[0], rng[-1]])
    types = _types(conn, False)
    locs = _locations(conn)
    buckets = list(dict.fromkeys(_bucket(d, per) for d in rng))
    points = []
    for b in buckets:
        in_b = [r for r in rs if _bucket(day_str(r["day"]), per) == b]
        values = {t["name"]: sum(r["n"] for r in in_b if r["type_id"] == t["id"]) for t in types}
        by_loc = {l["code"]: sum(r["n"] for r in in_b if r["location_id"] == l["id"]) for l in locs}
        points.append({"bucket": b, "values": values, "byLocation": by_loc, "total": sum(values.values())})
    return {"per": per, "series": [t["name"] for t in types], "locations": [l["code"] for l in locs], "points": points,
            "total": sum(p["total"] for p in points)}


def issued(conn: Connection, days: int, now: datetime | None = None) -> dict:
    """TRD-02: items issued per day by garment type, with unregistered garments as their own series;
    byLocation splits each day's total (and byLocationValues the per-type numbers)."""
    now = now or now_utc()
    rng = day_range(days, now)
    rs = rows(conn, """SELECT ii.issued_day AS day, si.garment_type_id AS type_id, si.location_id, COUNT(*) AS n
                         FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
                        WHERE ii.issued_day BETWEEN ? AND ? AND ii.status IN ('applied','before_start')
                        GROUP BY ii.issued_day, si.garment_type_id, si.location_id""", [rng[0], rng[-1]])
    by: dict[tuple, int] = {}
    for r in rs:
        by[(day_str(r["day"]), r["type_id"], r["location_id"])] = r["n"]
    # Unregistered garments are their own series (barcodes left out in Settings › Data quality are 'ignored').
    types = _types(conn, True)
    locs = _locations(conn)
    points = []
    for day in rng:
        per_loc = {l["code"]: {t["name"]: by.get((day, t["id"], l["id"]), 0) for t in types} for l in locs}
        values = {t["name"]: sum(per_loc[l["code"]][t["name"]] for l in locs) for t in types}
        points.append({"day": day, "values": values, "byLocation": {k: sum(v.values()) for k, v in per_loc.items()},
                       "byLocationValues": per_loc, "total": sum(values.values())})
    weekdays = [p for p in points[:-1] if date.fromisoformat(p["day"]).isoweekday() <= 5]
    avg = sum(p["total"] for p in weekdays) / len(weekdays) if weekdays else 0
    return {"series": [t["name"] for t in types], "locations": [l["code"] for l in locs], "points": points,
            "weekdayAverage": round(avg), "today": site_day(now)}


def stock_over_time(conn: Connection, days: int, now: datetime | None = None) -> dict:
    """TRD-03/04: end-of-day stock per garment type (values: all locations; byLocation: per location), plus
    delivered vs issued per day. A location contributes only from the day of its starting count; before it,
    its stock is None."""
    rng = day_range(days, now)
    start_day = {r["location_id"]: site_day(from_db(r["as_of"])) for r in rows(conn, "SELECT location_id, as_of FROM starting_count")}
    opening = rows(conn, """SELECT si.garment_type_id AS type_id, si.location_id, SUM(l.delta) AS n FROM ledger_entry l
                              JOIN stock_item si ON si.id = l.stock_item_id WHERE l.day < ? GROUP BY si.garment_type_id, si.location_id""", [rng[0]])
    daily = rows(conn, """SELECT l.day, si.garment_type_id AS type_id, si.location_id, SUM(l.delta) AS n FROM ledger_entry l
                            JOIN stock_item si ON si.id = l.stock_item_id WHERE l.day BETWEEN ? AND ?
                           GROUP BY l.day, si.garment_type_id, si.location_id""", [rng[0], rng[-1]])
    types = _types(conn, False)
    locs = _locations(conn)
    running = {(o["type_id"], o["location_id"]): o["n"] for o in opening}
    points = []
    for day in rng:
        for d in daily:
            if day_str(d["day"]) == day:
                k = (d["type_id"], d["location_id"])
                running[k] = running.get(k, 0) + d["n"]
        live = [l for l, s in start_day.items() if s <= day]
        values = {t["name"]: (sum(running.get((t["id"], l), 0) for l in live) if live else None) for t in types}
        by_loc = {l["code"]: {t["name"]: (running.get((t["id"], l["id"]), 0) if l["id"] in live else None) for t in types} for l in locs}
        points.append({"day": day, "values": values, "byLocation": by_loc})
    dl, iss = delivered(conn, days, "day", now), issued(conn, days, now)
    flows = [{"day": day, "delivered": dl["points"][i]["total"], "issued": iss["points"][i]["total"],
              "byLocation": {l["code"]: {"delivered": dl["points"][i]["byLocation"][l["code"]], "issued": iss["points"][i]["byLocation"][l["code"]]}
                             for l in locs}}
             for i, day in enumerate(rng)]
    d_tot, i_tot = sum(f["delivered"] for f in flows), sum(f["issued"] for f in flows)
    return {"series": [t["name"] for t in types], "locations": [l["code"] for l in locs], "points": points, "flows": flows,
            "totals": {"delivered": d_tot, "issued": i_tot, "net": d_tot - i_tot}}


def breakdown(conn: Connection, days: int, metric: str, now: datetime | None = None) -> dict:
    """TRD-06: breakdown by size (with each location's share) and by location for the range."""
    rng = day_range(days, now)
    sql = ("""SELECT s.code AS size, l.code AS location, COUNT(*) AS n FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
                JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
               WHERE ii.issued_day BETWEEN ? AND ? AND ii.status IN ('applied','before_start') GROUP BY s.code, s.sort, l.code ORDER BY s.sort"""
           if metric == "issued" else
           """SELECT s.code AS size, l.code AS location, SUM(dl.qty_current) AS n FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id
                JOIN stock_item si ON si.id = dl.stock_item_id JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
               WHERE d.received_day BETWEEN ? AND ? GROUP BY s.code, s.sort, l.code ORDER BY s.sort""")
    locs = [l["code"] for l in _locations(conn)]
    by_size: dict[str, dict] = {}
    by_loc: dict[str, int] = {}
    for r in rows(conn, sql, [rng[0], rng[-1]]):
        e = by_size.setdefault(r["size"], {"size": r["size"], "n": 0, "byLocation": {l: 0 for l in locs}})
        e["n"] += r["n"]
        e["byLocation"][r["location"]] = e["byLocation"].get(r["location"], 0) + r["n"]
        by_loc[r["location"]] = by_loc.get(r["location"], 0) + r["n"]
    return {"metric": metric, "locations": locs, "bySize": list(by_size.values()),
            "byLocation": [{"location": k, "n": v} for k, v in by_loc.items()]}
