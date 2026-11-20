from datetime import datetime, timezone

import pytest
from conftest import on_hand, ref_ids, user_id

from gi.auth import HttpError
from gi.db import connect, one, rows
from gi.ledger import invariant_violations
from gi.services.counts import CorrectionInput, CountLine, StartingCountInput, save_correction, save_starting_count
from gi.services.deliveries import CorrectionInput as DCorrection
from gi.services.deliveries import DeliveryInput, DeliveryLine, correct_delivery, post_delivery
from gi.services.stock import stock_summary

pytestmark = pytest.mark.usefixtures("fresh_db")
NOW = datetime(2026, 11, 20, 19, 0, tzinfo=timezone.utc)


@pytest.fixture
def ids():
    return ref_ids()


def line(ids, qty, size="LG", loc="P1"):
    return DeliveryLine(garmentTypeId=ids["type"]["GOWN"], colorId=ids["color"]["White"], sizeId=ids["size"][size],
                        locationId=ids["loc"][loc], qty=qty)


def violations():
    with connect() as c:
        return invariant_violations(c)


def test_post_merges_lines_and_ignores_a_retry(ids):
    u = user_id("dev-floor")
    r = post_delivery(DeliveryInput(lines=[line(ids, 30), line(ids, 10), line(ids, 5, "MED")]), "key-1", u, NOW)
    assert (r["duplicate"], r["total"], r["lines"]) == (False, 45, 2)
    assert post_delivery(DeliveryInput(lines=[line(ids, 30)]), "key-1", u, NOW)["duplicate"] is True
    assert on_hand("GOWN", "White", "LG", "P1") == 40


def test_correction_applies_the_difference_and_void_reverses(ids):
    u = user_id("dev-floor")
    d = post_delivery(DeliveryInput(lines=[line(ids, 60), line(ids, 40, "MED")]), "k", u, NOW)
    with connect() as c:
        lg, med = [r["id"] for r in rows(c, "SELECT id FROM delivery_line WHERE delivery_id = ? ORDER BY id", [d["id"]])]
    assert correct_delivery(d["id"], DCorrection(lines=[{"lineId": lg, "qty": 50}]), u, NOW)["totalDelta"] == -10
    assert on_hand("GOWN", "White", "LG", "P1") == 50
    v = correct_delivery(d["id"], DCorrection(void=True, lines=[]), u, NOW)
    assert (v["voided"], v["totalDelta"]) == (True, -90)
    assert on_hand("GOWN", "White", "MED", "P1") == 0
    assert med > 0
    assert violations() == []


def test_starting_count_keeps_later_deliveries(ids):
    # Delivery 07:00 Phoenix; the count was finished at 06:00 but entered later.
    post_delivery(DeliveryInput(receivedAt="2026-11-20T14:00:00Z", lines=[line(ids, 30)]), "d1", user_id("dev-floor"), NOW)
    save_starting_count(StartingCountInput(locationId=ids["loc"]["P1"], asOf="2026-11-20T13:00:00Z", counts=[
        CountLine(garmentTypeId=ids["type"]["GOWN"], colorId=ids["color"]["White"], sizeId=ids["size"]["LG"], qty=42)]), user_id(), NOW)
    assert on_hand("GOWN", "White", "LG", "P1") == 72
    assert violations() == []


def test_refuses_to_correct_a_delivery_the_count_includes(ids):
    d = post_delivery(DeliveryInput(receivedAt="2026-11-20T12:00:00Z", lines=[line(ids, 30)]), "d1", user_id("dev-floor"), NOW)
    save_starting_count(StartingCountInput(locationId=ids["loc"]["P1"], asOf="2026-11-20T13:00:00Z", counts=[]), user_id(), NOW)
    with connect() as c:
        dl = one(c, "SELECT id FROM delivery_line WHERE delivery_id = ?", [d["id"]])
    with pytest.raises(HttpError, match="starting count"):
        correct_delivery(d["id"], DCorrection(lines=[{"lineId": dl["id"], "qty": 20}]), user_id(), NOW)  # type: ignore[index]


def test_spot_check_clears_the_unregistered_bucket(ids):
    r = save_correction(CorrectionInput(reason="spot_check", locationId=ids["loc"]["P1"], clearUnregistered=True, items=[
        CountLine(garmentTypeId=ids["type"]["GOWN"], colorId=ids["color"]["White"], sizeId=ids["size"]["LG"], qty=12)]), user_id(), NOW)
    assert len(r["changed"]) == 1  # bucket was already 0
    assert on_hand("GOWN", "White", "LG", "P1") == 12


def test_reorder_list(ids):
    post_delivery(DeliveryInput(lines=[line(ids, 3)]), "k", user_id("dev-floor"), NOW)  # min is 20 in the dev seed
    with connect() as c:
        s = stock_summary(c, NOW)
    ratios = [r["on_hand"] / r["min_qty"] for r in s["reorder"]]
    assert ratios == sorted(ratios)
    assert all(r["on_hand"] < r["min_qty"] for r in s["reorder"])
    assert s["belowMinCount"] == 90
    assert next(t for t in s["totals"] if t["name"] == "Gown")["onHand"] == 3
