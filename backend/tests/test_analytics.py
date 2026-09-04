"""
tests/test_analytics.py
Analytics ingestion + reporting test suite. Supabase is replaced with a
small in-memory fake query builder (supports the subset of the
PostgREST-style chain the service layer uses: select/insert/update,
eq/gte/lte/in_/is_/order/range/limit, count="exact") so these tests
exercise the real aggregation logic in app/services/analytics.py without
needing live Supabase credentials.

Run with:
    pytest tests/test_analytics.py -v
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
import app.services.analytics as analytics_service  # noqa: E402
import app.routes.analytics as analytics_route  # noqa: E402

client = TestClient(app)


class FakeResult:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class FakeQuery:
    def __init__(self, store, table_name):
        self.store = store
        self.table_name = table_name
        self.mode = "select"
        self.payload = None
        self.filters = []
        self.order_col = None
        self.order_desc = False
        self.range_start = None
        self.range_end = None
        self.limit_n = None
        self.count_mode = None

    def select(self, cols="*", count=None):
        self.count_mode = count
        return self

    def insert(self, payload):
        self.mode = "insert"
        self.payload = payload if isinstance(payload, list) else [payload]
        return self

    def update(self, payload):
        self.mode = "update"
        self.payload = payload
        return self

    def delete(self):
        self.mode = "delete"
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def gte(self, col, val):
        self.filters.append(("gte", col, val))
        return self

    def lte(self, col, val):
        self.filters.append(("lte", col, val))
        return self

    def in_(self, col, vals):
        self.filters.append(("in", col, vals))
        return self

    def is_(self, col, val):
        self.filters.append(("is", col, val))
        return self

    def order(self, col, desc=False):
        self.order_col = col
        self.order_desc = desc
        return self

    def range(self, start, end):
        self.range_start = start
        self.range_end = end
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def _apply_filters(self, rows):
        result = rows
        for op, col, val in self.filters:
            if op == "eq":
                result = [r for r in result if r.get(col) == val]
            elif op == "gte":
                result = [r for r in result if (r.get(col) or "") >= val]
            elif op == "lte":
                result = [r for r in result if (r.get(col) or "") <= val]
            elif op == "in":
                result = [r for r in result if r.get(col) in val]
            elif op == "is" and val == "null":
                result = [r for r in result if r.get(col) is None]
        return result

    def execute(self):
        table = self.store.setdefault(self.table_name, [])
        if self.mode == "insert":
            for row in self.payload:
                table.append(dict(row))
            return FakeResult(data=[dict(r) for r in self.payload])
        if self.mode == "update":
            matched = self._apply_filters(table)
            for row in matched:
                row.update(self.payload)
            return FakeResult(data=[dict(r) for r in matched])
        if self.mode == "delete":
            matched = self._apply_filters(table)
            for row in matched:
                table.remove(row)
            return FakeResult(data=[dict(r) for r in matched])

        rows = self._apply_filters(table)
        total_count = len(rows) if self.count_mode == "exact" else None
        if self.order_col:
            rows = sorted(rows, key=lambda r: (r.get(self.order_col) is None, r.get(self.order_col)), reverse=self.order_desc)
        if self.range_start is not None:
            rows = rows[self.range_start : self.range_end + 1]
        if self.limit_n is not None:
            rows = rows[: self.limit_n]
        return FakeResult(data=[dict(r) for r in rows], count=total_count)


class FakeTable:
    def __init__(self, store, name):
        self.store = store
        self.name = name

    def select(self, cols="*", count=None):
        return FakeQuery(self.store, self.name).select(cols, count)

    def insert(self, payload):
        return FakeQuery(self.store, self.name).insert(payload)

    def update(self, payload):
        return FakeQuery(self.store, self.name).update(payload)

    def delete(self):
        return FakeQuery(self.store, self.name).delete()


class FakeSupabaseClient:
    def __init__(self):
        self.store = {}

    def table(self, name):
        return FakeTable(self.store, name)


@pytest.fixture
def fake_db(monkeypatch):
    fake_client = FakeSupabaseClient()
    monkeypatch.setattr(analytics_service, "get_supabase_client", lambda: fake_client)
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    yield fake_client


def base_ctx(client_id="client-00000001", version="1.2.0"):
    return {
        "client_id": client_id,
        "extension_version": version,
        "browser": "Chrome",
        "browser_version": "131",
        "os": "Windows",
        "device_type": "desktop",
    }


def test_session_start_creates_installation_and_session(fake_db):
    payload = {**base_ctx(), "session_id": "session-000001"}
    res = client.post("/api/session/start", json=payload)
    assert res.status_code == 200
    assert len(fake_db.store["installations"]) == 1
    assert len(fake_db.store["sessions"]) == 1
    assert fake_db.store["sessions"][0]["session_id"] == "session-000001"


def test_session_start_upserts_existing_installation_without_duplicating(fake_db):
    payload = {**base_ctx(), "session_id": "session-000001"}
    client.post("/api/session/start", json=payload)
    payload2 = {**base_ctx(version="1.3.0"), "session_id": "session-000002"}
    client.post("/api/session/start", json=payload2)
    assert len(fake_db.store["installations"]) == 1  # same client_id, updated not duplicated
    assert fake_db.store["installations"][0]["extension_version"] == "1.3.0"
    assert len(fake_db.store["sessions"]) == 2


def test_session_end_marks_ended_at(fake_db):
    client.post("/api/session/start", json={**base_ctx(), "session_id": "session-000001"})
    res = client.post("/api/session/end", json={"session_id": "session-000001"})
    assert res.status_code == 200
    assert res.json()["found"] is True
    assert fake_db.store["sessions"][0]["ended_at"] is not None


def test_session_end_unknown_session_reports_not_found(fake_db):
    res = client.post("/api/session/end", json={"session_id": "does-not-exist-00"})
    assert res.status_code == 200
    assert res.json()["found"] is False


def test_ingest_events_inserts_rows(fake_db):
    payload = {
        "events": [
            {**base_ctx(), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot", "action": "visible_tab"},
            {**base_ctx(), "session_id": "session-000001", "event_type": "LINK_GENERATED", "feature": "sharing", "action": "backend"},
        ]
    }
    res = client.post("/api/events", json=payload)
    assert res.status_code == 200
    assert res.json()["ingested"] == 2
    assert len(fake_db.store["events"]) == 2
    # ingesting events also keeps the installation's last_seen fresh
    assert len(fake_db.store["installations"]) == 1


def test_ingest_events_rejects_empty_batch(fake_db):
    res = client.post("/api/events", json={"events": []})
    assert res.status_code == 422


def test_overview_aggregates_counts_and_features(fake_db):
    events = [
        {**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot", "success": True},
        {**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot", "success": True},
        {**base_ctx("client-00000002"), "session_id": "session-000002", "event_type": "SCREEN_RECORDING_STOPPED", "feature": "recording", "success": True},
        {**base_ctx("client-00000002"), "session_id": "session-000002", "event_type": "SCREENSHOT_UPLOADED", "feature": "sharing", "success": True},
        {**base_ctx("client-00000002"), "session_id": "session-000002", "event_type": "LINK_GENERATED", "feature": "sharing", "success": False, "error_message": "network"},
    ]
    client.post("/api/events", json={"events": events})

    res = client.get("/api/analytics/overview?days=30")
    assert res.status_code == 200
    body = res.json()
    assert body["total_users"] == 2
    assert body["screenshots_captured"] == 2
    assert body["screen_recordings"] == 1
    assert body["uploads"] == 1
    assert body["links_generated"] == 1
    assert body["failed_operations"] == 1
    feature_names = {f["feature"] for f in body["most_used_features"]}
    assert {"screenshot", "recording", "sharing"} <= feature_names


def test_users_list_includes_session_and_action_counts(fake_db):
    client.post("/api/session/start", json={**base_ctx("client-00000001"), "session_id": "session-000001"})
    client.post(
        "/api/events",
        json={"events": [{**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot"}]},
    )
    res = client.get("/api/analytics/users")
    assert res.status_code == 200
    users = res.json()
    assert len(users) == 1
    assert users[0]["client_id"] == "client-00000001"
    assert users[0]["total_sessions"] == 1
    assert users[0]["total_actions"] == 1


def test_user_detail_not_found(fake_db):
    res = client.get("/api/analytics/user/nonexistent")
    assert res.status_code == 404


def test_user_detail_returns_timeline_and_aggregates(fake_db):
    client.post("/api/session/start", json={**base_ctx("client-00000001"), "session_id": "session-000001"})
    client.post(
        "/api/events",
        json={
            "events": [
                {**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot"},
                {**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "LINK_GENERATED", "feature": "sharing"},
            ]
        },
    )
    res = client.get("/api/analytics/user/client-00000001")
    assert res.status_code == 200
    body = res.json()
    assert body["screenshots"] == 1
    assert body["links_generated"] == 1
    assert body["total_actions"] == 2
    assert len(body["activity_timeline"]) == 2


def test_timeseries_dau_and_screenshots(fake_db):
    client.post(
        "/api/events",
        json={
            "events": [
                {**base_ctx("client-00000001"), "session_id": "session-000001", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot"},
                {**base_ctx("client-00000002"), "session_id": "session-000002", "event_type": "SCREENSHOT_CAPTURED", "feature": "screenshot"},
            ]
        },
    )
    res = client.get("/api/analytics/timeseries?metric=dau&days=7")
    assert res.status_code == 200
    points = res.json()
    assert len(points) == 7
    assert points[-1]["count"] == 2  # today: two distinct clients active

    res2 = client.get("/api/analytics/timeseries?metric=screenshots&days=7")
    assert res2.json()[-1]["count"] == 2


def test_timeseries_rejects_unknown_metric(fake_db):
    res = client.get("/api/analytics/timeseries?metric=bogus&days=7")
    assert res.status_code == 422  # fails the Query(pattern=...) validation


def test_dashboard_token_gates_reporting_endpoints_but_not_ingestion(fake_db, monkeypatch):
    monkeypatch.setattr(analytics_route.settings, "ANALYTICS_DASHBOARD_TOKEN", "secret123")

    # Ingestion must still work with no token at all.
    res = client.post("/api/session/start", json={**base_ctx(), "session_id": "session-0000xx"})
    assert res.status_code == 200

    # Reporting endpoints reject missing/wrong token...
    res = client.get("/api/analytics/overview")
    assert res.status_code == 401
    res = client.get("/api/analytics/overview", headers={"X-Analytics-Token": "wrong"})
    assert res.status_code == 401

    # ...and accept the correct one.
    res = client.get("/api/analytics/overview", headers={"X-Analytics-Token": "secret123"})
    assert res.status_code == 200


def test_reporting_endpoints_open_when_no_token_configured(fake_db):
    res = client.get("/api/analytics/overview")
    assert res.status_code == 200


def test_resolve_country_reads_known_headers_only():
    headers = {"cf-ipcountry": "us"}
    assert analytics_service.resolve_country(headers) == "US"

    headers2 = {"cf-ipcountry": "XX"}  # Cloudflare's "unknown" sentinel
    assert analytics_service.resolve_country(headers2) is None

    headers3 = {}
    assert analytics_service.resolve_country(headers3) is None


def test_ingestion_and_reporting_return_clean_503_when_supabase_unconfigured(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "")

    res = client.post(
        "/api/session/start",
        json={**base_ctx(), "session_id": "session-000001"},
    )
    assert res.status_code == 503

    res2 = client.get("/api/analytics/overview")
    assert res2.status_code == 503
