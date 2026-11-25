"""Builds a demo database: resets it, imports the mock Oracle data, enters a starting count for both locations (P1, P2)
21 days ago and a morning delivery every day since. Dev only (refuses unless DEV_AUTH=true).
Usage: python -m gi.cli.demo"""
import math
import random
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from ..config import config
from ..db import connect, one, rows
from ..importing import get_issue_source
from ..importing.importer import poll, sync_master
from ..migrate import migrate, reset_database
from ..services.counts import CountLine, StartingCountInput, save_starting_count
from ..services.deliveries import DeliveryInput, DeliveryLine, post_delivery
from ..stock_items import reset_caches
from ..timeutil import iso, now_utc, to_db


def main() -> None:
    if not config.DEV_AUTH:
        raise SystemExit("refusing: DEV_AUTH is not true")
    reset_database()
    migrate(seed_dev=True)
    reset_caches()
    with connect() as c:
        lead = one(c, "SELECT id FROM app_user WHERE sso_subject = 'dev-lead'")["id"]  # type: ignore[index]
        floor = one(c, "SELECT id FROM app_user WHERE sso_subject = 'dev-floor'")["id"]  # type: ignore[index]

    source = get_issue_source()
    print("barcode master", {k: v for k, v in sync_master(source).items() if k in ("rows", "barcodes")})
    print("import", poll(source, now_utc(), "backfill")["byStatus"])

    tz = ZoneInfo(config.SITE_TIMEZONE)
    now = datetime.now(tz)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_day = today - timedelta(days=21)
    as_of = start_day.replace(hour=5)

    # Average daily issues per item over the week before the count → starting stock of ~4 days.
    with connect() as c:
        usage = rows(c, """SELECT si.location_id, si.garment_type_id, si.color_id, si.size_id, COUNT(*) / 7 AS n
                             FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id JOIN garment_type g ON g.id = si.garment_type_id
                            WHERE NOT g.is_system AND ii.issued_day >= ? AND ii.issued_day < ?
                            GROUP BY si.location_id, si.garment_type_id, si.color_id, si.size_id""",
                     [(start_day - timedelta(days=7)).date().isoformat(), start_day.date().isoformat()])
        locations = rows(c, "SELECT id, code FROM location")
    for loc in locations:
        lines = [CountLine(garmentTypeId=u["garment_type_id"], colorId=u["color_id"], sizeId=u["size_id"], qty=round(float(u["n"]) * 4))
                 for u in usage if u["location_id"] == loc["id"]]
        r = save_starting_count(StartingCountInput(locationId=loc["id"], asOf=iso(as_of), counts=lines), lead)  # type: ignore[arg-type]
        print(f"starting count {loc['code']}: {len(lines)} items, {r['issuesApplied']} issues applied since")

    # Each morning at 06:40 a delivery tops every item back up to ~4 days of its usual use.
    key = lambda u: (u["location_id"], u["garment_type_id"], u["color_id"], u["size_id"])  # noqa: E731
    target = {key(u): math.ceil(float(u["n"]) * 4) for u in usage}
    d = start_day + timedelta(days=1)
    while d <= today:
        at = d.replace(hour=6, minute=40)
        if at > now:
            break
        with connect() as c:
            balances = rows(c, """SELECT si.location_id, si.garment_type_id, si.color_id, si.size_id, COALESCE(SUM(l.delta), 0) AS bal
                                    FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id
                                    LEFT JOIN ledger_entry l ON l.stock_item_id = si.id AND l.at < ?
                                   WHERE NOT g.is_system GROUP BY si.id""", [to_db(at)])
        lines = []
        for b in balances:
            qty = round(max(0, target.get(key(b), 0) - b["bal"]) * (0.85 + random.random() * 0.3) / 5) * 5
            if qty > 0:
                lines.append(DeliveryLine(garmentTypeId=b["garment_type_id"], colorId=b["color_id"], sizeId=b["size_id"],
                                          locationId=b["location_id"], qty=qty))
        if lines:
            post_delivery(DeliveryInput(lines=lines), f"demo-{d.date().isoformat()}", floor, at.astimezone(ZoneInfo("UTC")))
        d += timedelta(days=1)
    with connect() as c:
        print(f"{one(c, 'SELECT COUNT(*) AS n FROM delivery')['n']} demo deliveries")  # type: ignore[index]
    source.close()


if __name__ == "__main__":
    main()
