"""Records the API responses the web page needs into frontend/demo-data, for the read-only demo on
GitHub Pages. Run after `python -m gi.cli.demo`. File names must match demoFile() in frontend/js/api.js."""
import re
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from ..app import build_app
from ..db import connect, rows

OUT = Path(__file__).resolve().parents[3] / "frontend" / "demo-data"


def demo_file(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", path.lstrip("/")) + ".json"


def main() -> None:
    client = TestClient(build_app())
    with connect() as c:
        types = rows(c, "SELECT id FROM garment_type WHERE active AND NOT is_system")
        locations = rows(c, "SELECT id FROM location")
        items = rows(c, "SELECT id FROM stock_item")
    paths = ["/me", "/meta", "/deliveries?limit=30", "/stock/summary", "/starting-counts", "/corrections", "/oracle-values",
             "/data-quality?days=30", "/data-quality/unregistered.csv", "/sync/status", "/sync/runs", "/alerts",
             *(f"/stock/grid?garmentTypeId={t['id']}&locationId={l['id']}" for t in types for l in locations),
             *(f"/stock/items/{i['id']}" for i in items)]
    # Must match the requests in frontend/js/pages/trends.js.
    for days in (7, 14, 30, 90):
        paths += [f"/trends/delivered?days={days}&per=day", f"/trends/delivered?days={max(days, 56)}&per=week",
                  f"/trends/delivered?days={max(days, 180)}&per=month", f"/trends/issued?days={days}", f"/trends/stock?days={days}",
                  f"/trends/breakdown?days={days}&metric=issued", f"/trends/breakdown?days={days}&metric=delivered"]
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    n = 0
    for p in dict.fromkeys(paths):
        res = client.get(f"/api{p}", headers={"x-dev-user": "dev-lead"})
        if res.status_code != 200:
            raise SystemExit(f"{p}: {res.status_code} {res.text}")
        (OUT / demo_file(p)).write_bytes(res.content)
        n += 1
    print(f"wrote {n} responses to {OUT}")


if __name__ == "__main__":
    main()
