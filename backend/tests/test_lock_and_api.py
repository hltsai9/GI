import threading

import pytest
from fastapi.testclient import TestClient

from gi import db as gidb
from gi.config import config
from gi.db import db_url, with_named_lock


def test_named_lock_lets_one_caller_run_at_a_time():
    started, release = threading.Event(), threading.Event()
    result = {}

    def hold():
        started.set()
        release.wait(5)
        return "first"

    t = threading.Thread(target=lambda: result.update(first=with_named_lock("test", hold)))
    t.start()
    started.wait(5)
    assert with_named_lock("test", lambda: "second") == (False, None)
    release.set()
    t.join()
    assert result["first"] == (True, "first")
    assert with_named_lock("test", lambda: "third") == (True, "third")
    gidb.dispose()


def test_db_settings_from_mariadb_host(monkeypatch):
    monkeypatch.setattr(config, "MARIADB_HOST", "db.example.local")
    monkeypatch.setattr(config, "MARIADB_PORT", 3307)
    monkeypatch.setattr(config, "MARIADB_PASSWORD", "p@ss:w/rd#1")
    monkeypatch.setattr(config, "MARIADB_DATABASE", "gi_test")
    u = db_url()
    assert (u.host, u.port, u.username, u.password, u.database) == ("db.example.local", 3307, "gi", "p@ss:w/rd#1", "gi_test")
    monkeypatch.setattr(config, "MARIADB_HOST", None)
    assert db_url().database == "gi_test"


@pytest.mark.usefixtures("fresh_db")
def test_api_basics(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>GI</title>")
    (tmp_path / "app.js").write_text("1")
    from gi.app import build_app
    c = TestClient(build_app(tmp_path))
    assert c.get("/healthz").text == "ok\n"
    assert c.get("/api/health").json() == {"ok": True}
    assert c.get("/api/me", headers={"x-dev-user": "dev-viewer"}).json()["role"] == "viewer"
    assert c.get("/api/nope").status_code == 404
    assert c.get("/api/stock/grid?garmentTypeId=x&locationId=1").status_code == 400
    # roles: a viewer cannot post a delivery
    r = c.post("/api/deliveries", json={"lines": []}, headers={"x-dev-user": "dev-viewer", "idempotency-key": "k"})
    assert r.status_code == 403
    # the web page: files, single-page fallback, no caching of index.html
    assert c.get("/app.js").text == "1"
    page = c.get("/trends")
    assert page.status_code == 200 and "GI" in page.text and page.headers["cache-control"] == "no-cache"
    assert c.get("/missing.js").status_code == 404
