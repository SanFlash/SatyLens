"""
tests/test_signed_upload.py
Tests for the new /api/upload/signed-url and /api/upload/complete
routes (app/routes/upload.py) -- the direct browser-to-Supabase upload
flow that removes the double-hop + memory-buffering bottleneck of the
original /api/upload endpoint for large files.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
from tests.test_analytics import FakeSupabaseClient  # noqa: E402

client = TestClient(app)


class FakeSignedUploadBucket:
    """Mimics storage3's bucket object: create_signed_upload_url() and
    list() are the two methods the new routes actually call."""

    def __init__(self, uploaded_objects):
        self._uploaded_objects = uploaded_objects  # {storage_path: size_bytes}
        self.last_signed_path = None

    def create_signed_upload_url(self, path):
        self.last_signed_path = path
        return {
            "signed_url": f"https://example.supabase.co/storage/v1/object/upload/sign/captures-bucket/{path}?token=fake-token-abc",
            "token": "fake-token-abc",
            "path": path,
        }

    def list(self, folder):
        results = []
        for full_path, size in self._uploaded_objects.items():
            if "/" in full_path:
                obj_folder, filename = full_path.rsplit("/", 1)
            else:
                obj_folder, filename = "", full_path
            if obj_folder == folder:
                results.append({"name": filename, "metadata": {"size": size}})
        return results

    def get_public_url(self, path):
        return f"https://cdn.example.com/{path}"


@pytest.fixture
def configured_settings(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    yield settings


@pytest.fixture
def fake_db_with_storage(monkeypatch):
    fake_client = FakeSupabaseClient()
    uploaded_objects = {}
    fake_bucket = FakeSignedUploadBucket(uploaded_objects)

    class FakeStorage:
        def from_(self, bucket_name):
            return fake_bucket

    fake_client.storage = FakeStorage()

    import app.services.storage as storage_service
    import app.routes.upload as upload_route

    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: fake_client)
    monkeypatch.setattr(upload_route, "get_capture_row", lambda share_id: _find_row(fake_client, share_id))
    monkeypatch.setattr(upload_route, "update_capture_row", lambda share_id, patch: _update_row(fake_client, share_id, patch))

    yield fake_client, fake_bucket, uploaded_objects


def _find_row(fake_client, share_id):
    for row in fake_client.store.get("captures", []):
        if row["share_id"] == share_id:
            return row
    return None


def _update_row(fake_client, share_id, patch):
    row = _find_row(fake_client, share_id)
    if row:
        row.update(patch)
    return row


# ============================== POST /api/upload/signed-url ==============================


def test_signed_url_request_rejects_bad_media_type(fake_db_with_storage, configured_settings):
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "clip.webm", "content_type": "video/webm", "media_type": "document", "client_id": "c1"},
    )
    # media_type is typed as a Literal in the Pydantic model, so FastAPI's
    # own request validation rejects an invalid value with 422 before the
    # route handler's manual check ever runs.
    assert res.status_code == 422


def test_signed_url_request_rejects_unsupported_mime_type(fake_db_with_storage, configured_settings):
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "doc.pdf", "content_type": "application/pdf", "media_type": "recording", "client_id": "c1"},
    )
    assert res.status_code == 400


def test_signed_url_request_returns_503_without_supabase_configured():
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "clip.webm", "content_type": "video/webm", "media_type": "recording", "client_id": "c1"},
    )
    assert res.status_code == 503


def test_signed_url_request_succeeds_and_creates_a_pending_row(fake_db_with_storage, configured_settings):
    fake_client, fake_bucket, _ = fake_db_with_storage
    res = client.post(
        "/api/upload/signed-url",
        json={
            "file_name": "meeting-recording.webm",
            "content_type": "video/webm;codecs=vp9,opus",
            "media_type": "recording",
            "client_id": "client-abc",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["signed_url"].startswith("https://")
    assert body["token"] == "fake-token-abc"
    assert body["storage_path"]

    rows = fake_client.store["captures"]
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "pending"
    assert row["storage_provider"] == "supabase"
    assert row["size_bytes"] == 0
    assert row["share_id"] == body["id"]
    assert row["client_id"] == "client-abc"


def test_signed_url_never_exposes_the_service_role_key(fake_db_with_storage, configured_settings):
    """The single most important security property of this whole flow:
    whatever gets handed to the browser must not contain the backend's
    own privileged credential."""
    configured_settings_secret = configured_settings.SUPABASE_SERVICE_ROLE_KEY
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "clip.webm", "content_type": "video/webm", "media_type": "recording", "client_id": "c1"},
    )
    assert res.status_code == 200
    body_text = res.text
    assert configured_settings_secret not in body_text


# ============================== POST /api/upload/complete ==============================


def test_complete_upload_returns_404_for_unknown_id(fake_db_with_storage, configured_settings):
    res = client.post("/api/upload/complete", json={"id": "does-not-exist", "duration_seconds": 0})
    assert res.status_code == 404


def test_complete_upload_fails_if_object_never_actually_uploaded(fake_db_with_storage, configured_settings):
    fake_client, fake_bucket, uploaded_objects = fake_db_with_storage
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "clip.webm", "content_type": "video/webm", "media_type": "recording", "client_id": "c1"},
    )
    upload_id = res.json()["id"]
    # Deliberately do NOT add anything to uploaded_objects -- simulates the
    # browser never actually completing its direct PUT to the signed URL.
    res2 = client.post("/api/upload/complete", json={"id": upload_id, "duration_seconds": 0})
    assert res2.status_code == 400


def test_complete_upload_succeeds_and_uses_the_REAL_server_recorded_size(fake_db_with_storage, configured_settings):
    """Critical integrity check: the completed row's size must come from
    Supabase's own object listing, not any value the client could have
    claimed -- the request body for /api/upload/complete doesn't even
    accept a size field, on purpose."""
    fake_client, fake_bucket, uploaded_objects = fake_db_with_storage
    res = client.post(
        "/api/upload/signed-url",
        json={"file_name": "clip.webm", "content_type": "video/webm", "media_type": "recording", "client_id": "c1"},
    )
    body = res.json()
    upload_id = body["id"]
    storage_path = body["storage_path"]

    # Simulate the browser's direct PUT to Supabase having genuinely finished.
    uploaded_objects[storage_path] = 314572800  # 300MB — deliberately far larger than the old 100MB cap

    res2 = client.post("/api/upload/complete", json={"id": upload_id, "duration_seconds": 42.5})
    assert res2.status_code == 200
    body2 = res2.json()
    assert body2["success"] is True
    assert body2["share_url"]

    row = _find_row(fake_client, upload_id)
    assert row["status"] == "complete"
    assert row["size_bytes"] == 314572800
    assert row["duration_seconds"] == 42.5


def test_complete_upload_rejects_an_r2_row(fake_db_with_storage, configured_settings):
    """/api/upload/complete is specifically for the Supabase signed-upload
    flow -- an R2 row hitting this endpoint by mistake should be rejected
    cleanly, not silently mishandled."""
    fake_client, fake_bucket, uploaded_objects = fake_db_with_storage
    fake_client.store.setdefault("captures", []).append(
        {
            "share_id": "r2-row-1",
            "storage_provider": "r2",
            "storage_path": "recordings/c1/2026/09/r2-row-1.webm",
            "status": "pending",
        }
    )
    res = client.post("/api/upload/complete", json={"id": "r2-row-1", "duration_seconds": 0})
    assert res.status_code == 400


def test_full_flow_end_to_end_for_a_large_file(fake_db_with_storage, configured_settings):
    """The complete, realistic scenario this whole feature exists for:
    request a signed URL, simulate the browser's direct upload (this
    backend's own HTTP handlers are never involved in that step at all),
    then complete it -- for a file far larger than the old fixed cap."""
    fake_client, fake_bucket, uploaded_objects = fake_db_with_storage
    res = client.post(
        "/api/upload/signed-url",
        json={
            "file_name": "huge-meeting-recording.webm",
            "content_type": "video/webm;codecs=vp9,opus",
            "media_type": "recording",
            "client_id": "client-xyz",
        },
    )
    assert res.status_code == 200
    body = res.json()

    # This backend never touches the bytes -- simulate ONLY the browser's
    # own direct PUT to Supabase succeeding.
    uploaded_objects[body["storage_path"]] = 1_500_000_000  # 1.5GB

    res2 = client.post("/api/upload/complete", json={"id": body["id"], "duration_seconds": 180})
    assert res2.status_code == 200
    final = res2.json()
    assert final["success"] is True
    row = _find_row(fake_client, body["id"])
    assert row["size_bytes"] == 1_500_000_000
    assert row["status"] == "complete"
