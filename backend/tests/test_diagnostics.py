"""
tests/test_diagnostics.py
Tests for GET /api/diagnostics/supabase -- the self-service setup
checker added to help pinpoint exactly which piece of a Supabase setup
is misconfigured (missing bucket, missing table, bad credentials, etc.)
without needing trial-and-error across real upload attempts.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
import app.routes.upload as upload_route  # noqa: E402

client = TestClient(app)


class FakeBucketObj:
    def __init__(self, name, public=False, file_size_limit=None):
        self.name = name
        self.public = public
        self.file_size_limit = file_size_limit


@pytest.fixture
def configured_settings(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    monkeypatch.setattr(settings, "SUPABASE_BUCKET", "captures")
    yield settings


def test_diagnostics_reports_not_configured_when_supabase_is_unset():
    res = client.get("/api/diagnostics/supabase")
    assert res.status_code == 200
    body = res.json()
    assert body["supabase_configured"] is False
    assert "SUPABASE_URL" in body["problem"]


def test_diagnostics_reports_missing_bucket_clearly(configured_settings, monkeypatch):
    class FakeStorage:
        def list_buckets(self):
            return [FakeBucketObj("some-other-bucket")]

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            raise AssertionError("should not check the table if the bucket check already tells the real story clearly")

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_exists"] is False
    assert "captures" in body["bucket_problem"]
    assert "some-other-bucket" in body["bucket_problem"]
    assert body["signed_upload_url_generation"] == "SKIPPED (bucket doesn't exist — fix that first)"
    assert "failed" in body["overall"].lower()


def test_diagnostics_reports_bad_credentials_clearly(configured_settings, monkeypatch):
    class FakeStorage:
        def list_buckets(self):
            raise Exception("401 Unauthorized: Invalid API key")

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            raise Exception("401 Unauthorized")

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_exists"] is None
    assert "service_role" in body["bucket_check_error"]


def test_diagnostics_reports_missing_table_when_bucket_is_fine(configured_settings, monkeypatch):
    class FakeQuery:
        def select(self, *a):
            return self

        def limit(self, *a):
            return self

        def execute(self):
            raise Exception('relation "captures" does not exist')

    class FakeStorage:
        def list_buckets(self):
            return [FakeBucketObj("captures", public=False)]

        def from_(self, name):
            class FakeBucket:
                def create_signed_upload_url(self, path):
                    return {"signed_url": "https://example.com/sign?token=x", "token": "x", "path": path}
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            return FakeQuery()

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())
    # create_signed_upload() lives in storage.py and calls ITS OWN
    # internal reference to get_supabase_client() (a same-module, bare-name
    # call) -- patching only upload_route's imported reference above
    # doesn't affect that. Patch the original module's attribute too.
    import app.services.storage as storage_service
    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_exists"] is True
    assert body["bucket_is_public"] is False
    assert body["captures_table_exists"] is False
    assert "does not exist" in body["captures_table_error"]
    assert body["signed_upload_url_generation"].startswith("OK")


def test_diagnostics_reports_everything_ok_end_to_end(configured_settings, monkeypatch):
    class FakeQuery:
        def select(self, *a):
            return self

        def limit(self, *a):
            return self

        def execute(self):
            return None

    class FakeStorage:
        def list_buckets(self):
            return [FakeBucketObj("captures", public=False)]

        def from_(self, name):
            class FakeBucket:
                def create_signed_upload_url(self, path):
                    return {"signed_url": "https://example.com/sign?token=x", "token": "x", "path": path}
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            return FakeQuery()

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())
    import app.services.storage as storage_service
    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_exists"] is True
    assert body["captures_table_exists"] is True
    assert body["signed_upload_url_generation"].startswith("OK")
    assert "everything checks out" in body["overall"].lower()


def test_diagnostics_detects_and_auto_fixes_a_restrictive_bucket_size_limit(configured_settings, monkeypatch):
    """Direct proof of the actual new fix: a bucket-level file_size_limit
    (a real, common default on a dashboard-created bucket, e.g. 50MB) is
    detected AND automatically removed via update_bucket(), not just
    reported -- this is exactly what "Upload to storage failed (400)"
    for large files specifically (while small ones succeed) means."""
    update_calls = []

    class FakeQuery:
        def select(self, *a):
            return self

        def limit(self, *a):
            return self

        def execute(self):
            return None

    class FakeStorage:
        def list_buckets(self):
            # 50MB limit -- Supabase's commonly-cited dashboard default.
            return [FakeBucketObj("captures", public=False, file_size_limit=52428800)]

        def update_bucket(self, bucket_id, options):
            update_calls.append((bucket_id, options))
            return {"message": "updated"}

        def from_(self, name):
            class FakeBucket:
                def create_signed_upload_url(self, path):
                    return {"signed_url": "https://example.com/sign?token=x", "token": "x", "path": path}
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            return FakeQuery()

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())
    import app.services.storage as storage_service
    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_file_size_limit_bytes"] == 52428800
    assert update_calls == [("captures", {"file_size_limit": None})]
    assert "removed it automatically" in body["bucket_file_size_limit_fix"]
    assert "50MB" in body["bucket_file_size_limit_fix"] or "52" in body["bucket_file_size_limit_fix"]


def test_diagnostics_reports_when_auto_fix_of_size_limit_itself_fails(configured_settings, monkeypatch):
    class FakeQuery:
        def select(self, *a):
            return self

        def limit(self, *a):
            return self

        def execute(self):
            return None

    class FakeStorage:
        def list_buckets(self):
            return [FakeBucketObj("captures", public=False, file_size_limit=10485760)]

        def update_bucket(self, bucket_id, options):
            raise Exception("403: insufficient permissions")

        def from_(self, name):
            class FakeBucket:
                def create_signed_upload_url(self, path):
                    return {"signed_url": "https://example.com/sign?token=x", "token": "x", "path": path}
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            return FakeQuery()

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())
    import app.services.storage as storage_service
    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_file_size_limit_bytes"] == 10485760
    assert "could not remove it automatically" in body["bucket_file_size_limit_fix"].lower()
    assert "insufficient permissions" in body["bucket_file_size_limit_fix"]


def test_diagnostics_does_not_touch_bucket_when_no_size_limit_is_set(configured_settings, monkeypatch):
    """A bucket with no file_size_limit already set (null/unlimited)
    should never trigger update_bucket() at all -- nothing to fix."""
    update_calls = []

    class FakeQuery:
        def select(self, *a):
            return self

        def limit(self, *a):
            return self

        def execute(self):
            return None

    class FakeStorage:
        def list_buckets(self):
            return [FakeBucketObj("captures", public=False, file_size_limit=None)]

        def update_bucket(self, bucket_id, options):
            update_calls.append((bucket_id, options))
            return {"message": "updated"}

        def from_(self, name):
            class FakeBucket:
                def create_signed_upload_url(self, path):
                    return {"signed_url": "https://example.com/sign?token=x", "token": "x", "path": path}
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

        def table(self, name):
            return FakeQuery()

    monkeypatch.setattr(upload_route, "get_supabase_client", lambda: FakeClient())
    import app.services.storage as storage_service
    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    res = client.get("/api/diagnostics/supabase")
    body = res.json()
    assert body["bucket_file_size_limit_bytes"] is None
    assert update_calls == []
    assert "bucket_file_size_limit_fix" not in body
