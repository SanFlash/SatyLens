"""
tests/test_r2_media.py
Tests for the Cloudflare R2 direct-upload flow: app/services/r2_storage.py
(validation + key generation, with boto3 mocked out) and
app/routes/media.py (upload-url / complete / history / detail / revoke /
expire / delete), reusing the FakeSupabaseClient from test_analytics.py
for the captures-table side.

Run with:
    pytest tests/test_r2_media.py -v
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
import app.services.r2_storage as r2_storage  # noqa: E402
import app.routes.media as media_route  # noqa: E402
from tests.test_analytics import FakeSupabaseClient  # noqa: E402

client = TestClient(app)


@pytest.fixture
def configured_settings(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    monkeypatch.setattr(settings, "R2_ACCOUNT_ID", "fake-account")
    monkeypatch.setattr(settings, "R2_ACCESS_KEY_ID", "fake-key-id")
    monkeypatch.setattr(settings, "R2_SECRET_ACCESS_KEY", "fake-secret")
    monkeypatch.setattr(settings, "R2_BUCKET_NAME", "qa-extension-media")
    yield settings


@pytest.fixture
def fake_db(monkeypatch):
    fake_client = FakeSupabaseClient()
    import app.services.storage as storage_service

    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: fake_client)
    yield fake_client


# ============================== r2_storage.py: pure validation/key logic ==============================


def test_validate_upload_request_accepts_known_types():
    ext = r2_storage.validate_upload_request("screenshot", "image/png", 1000)
    assert ext == "png"
    ext2 = r2_storage.validate_upload_request("recording", "video/webm", 5_000_000)
    assert ext2 == "webm"


def test_validate_upload_request_accepts_video_mime_type_with_codec_parameters():
    """Regression test: MediaRecorder reports the full codec-qualified
    Content-Type (e.g. "video/webm;codecs=vp9,opus"), which the extension
    sends verbatim. A bare-string allow-list check rejects every real
    recording -- this must still resolve to the right extension too,
    since build_object_key() depends on it."""
    ext = r2_storage.validate_upload_request("recording", "video/webm;codecs=vp9,opus", 5_000_000)
    assert ext == "webm"
    ext2 = r2_storage.validate_upload_request("recording", "video/webm;codecs=vp8,opus", 5_000_000)
    assert ext2 == "webm"


def test_validate_upload_request_rejects_unknown_media_type():
    with pytest.raises(r2_storage.R2ValidationError):
        r2_storage.validate_upload_request("banana", "image/png", 1000)


def test_validate_upload_request_rejects_unknown_content_type():
    with pytest.raises(r2_storage.R2ValidationError):
        r2_storage.validate_upload_request("screenshot", "application/octet-stream", 1000)


def test_validate_upload_request_rejects_zero_or_negative_size():
    with pytest.raises(r2_storage.R2ValidationError):
        r2_storage.validate_upload_request("screenshot", "image/png", 0)


def test_validate_upload_request_rejects_oversized_file(configured_settings, monkeypatch):
    monkeypatch.setattr(configured_settings, "MAX_FILE_SIZE_MB", 1)
    with pytest.raises(r2_storage.R2ValidationError):
        r2_storage.validate_upload_request("screenshot", "image/png", 2 * 1024 * 1024)


def test_build_object_key_never_uses_the_raw_filename():
    key = r2_storage.build_object_key("screenshot", "client-00000001", "png")
    assert key.startswith("screenshots/client-00000001/")
    assert key.endswith(".png")
    # No path traversal survives into the key, even if a caller tried.
    dirty_key = r2_storage.build_object_key("screenshot", "../../etc/passwd", "png")
    assert ".." not in dirty_key
    assert "/" not in dirty_key.split("/")[1]  # the sanitized client_id segment


def test_build_object_key_is_unique_across_calls():
    keys = {r2_storage.build_object_key("screenshot", "client-00000001", "png") for _ in range(50)}
    assert len(keys) == 50


def test_build_object_key_uses_correct_folder_per_media_type():
    assert r2_storage.build_object_key("screenshot", "c1", "png").startswith("screenshots/")
    assert r2_storage.build_object_key("recording", "c1", "webm").startswith("recordings/")
    assert r2_storage.build_object_key("collage", "c1", "png").startswith("collages/")


# ============================== /api/media/upload-url ==============================


def test_upload_url_returns_503_without_r2_configured(fake_db, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    monkeypatch.setattr(settings, "R2_ACCOUNT_ID", "")
    res = client.post(
        "/api/media/upload-url",
        json={"file_name": "shot.png", "content_type": "image/png", "file_size": 1000, "media_type": "screenshot"},
    )
    assert res.status_code == 503


def test_upload_url_rejects_invalid_content_type(fake_db, configured_settings):
    res = client.post(
        "/api/media/upload-url",
        json={"file_name": "shot.exe", "content_type": "application/octet-stream", "file_size": 1000, "media_type": "screenshot"},
    )
    assert res.status_code == 400


def test_upload_url_success_creates_pending_row(fake_db, configured_settings, monkeypatch):
    monkeypatch.setattr(media_route.r2_storage, "generate_presigned_put_url", lambda key, ct: f"https://r2.example/{key}?sig=abc")

    res = client.post(
        "/api/media/upload-url",
        json={
            "file_name": "bug-login.png",
            "content_type": "image/png",
            "file_size": 245678,
            "media_type": "screenshot",
            "client_id": "client-00000001",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["object_key"].startswith("screenshots/client-00000001/")
    assert body["upload_url"].startswith("https://r2.example/")
    assert body["expires_in"] == 900

    rows = fake_db.store["captures"]
    assert len(rows) == 1
    assert rows[0]["status"] == "pending"
    assert rows[0]["storage_provider"] == "r2"
    assert rows[0]["share_id"] == body["upload_id"]


def test_upload_url_accepts_video_with_codec_parameters_end_to_end(fake_db, configured_settings, monkeypatch):
    """Full-endpoint regression test for the codec-parameter MIME bug --
    a recording upload request must succeed and produce a correctly
    extensioned .webm object key, not a 400."""
    monkeypatch.setattr(media_route.r2_storage, "generate_presigned_put_url", lambda key, ct: f"https://r2.example/{key}?sig=abc")

    res = client.post(
        "/api/media/upload-url",
        json={
            "file_name": "bug-repro.webm",
            "content_type": "video/webm;codecs=vp9,opus",
            "file_size": 5_000_000,
            "media_type": "recording",
            "client_id": "client-00000001",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["object_key"].endswith(".webm")


# ============================== /api/media/complete ==============================


def test_complete_upload_rejects_unknown_upload_id(fake_db, configured_settings):
    res = client.post(
        "/api/media/complete",
        json={
            "upload_id": "does-not-exist",
            "object_key": "screenshots/x/y/z.png",
            "media_type": "screenshot",
            "file_name": "shot.png",
            "content_type": "image/png",
            "file_size": 1000,
        },
    )
    assert res.status_code == 404


def test_complete_upload_rejects_object_key_mismatch(fake_db, configured_settings):
    fake_db.store["captures"] = [
        {"share_id": "up1", "storage_path": "screenshots/x/y/real-key.png", "status": "pending"}
    ]
    res = client.post(
        "/api/media/complete",
        json={
            "upload_id": "up1",
            "object_key": "screenshots/x/y/DIFFERENT-key.png",
            "media_type": "screenshot",
            "file_name": "shot.png",
            "content_type": "image/png",
            "file_size": 1000,
        },
    )
    assert res.status_code == 400


def test_complete_upload_rejects_when_object_not_actually_in_r2(fake_db, configured_settings, monkeypatch):
    fake_db.store["captures"] = [
        {"share_id": "up1", "storage_path": "screenshots/x/y/real-key.png", "status": "pending"}
    ]
    monkeypatch.setattr(media_route.r2_storage, "object_exists", lambda key: (False, 0))
    res = client.post(
        "/api/media/complete",
        json={
            "upload_id": "up1",
            "object_key": "screenshots/x/y/real-key.png",
            "media_type": "screenshot",
            "file_name": "shot.png",
            "content_type": "image/png",
            "file_size": 1000,
        },
    )
    assert res.status_code == 400
    # Never trusted-and-marked-complete on the client's claim alone.
    assert fake_db.store["captures"][0]["status"] == "pending"


def test_complete_upload_success_uses_r2s_actual_size_not_the_clients_claim(fake_db, configured_settings, monkeypatch):
    fake_db.store["captures"] = [
        {"share_id": "up1", "storage_path": "screenshots/x/y/real-key.png", "status": "pending", "size_bytes": 999999}
    ]
    monkeypatch.setattr(media_route.r2_storage, "object_exists", lambda key: (True, 245678))

    res = client.post(
        "/api/media/complete",
        json={
            "upload_id": "up1",
            "object_key": "screenshots/x/y/real-key.png",
            "media_type": "screenshot",
            "file_name": "shot.png",
            "content_type": "image/png",
            "file_size": 999999,  # client's (wrong) claim
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["share_url"].endswith("/s/up1")
    assert fake_db.store["captures"][0]["status"] == "complete"
    assert fake_db.store["captures"][0]["size_bytes"] == 245678  # R2's real size, not the client's claim


# ============================== history / detail / revoke / expire / delete ==============================


def _seed_complete_row(fake_db, **overrides):
    row = {
        "share_id": "share-0001",
        "type": "screenshot",
        "original_filename": "shot.png",
        "storage_path": "screenshots/c1/2026/08/uuid.png",
        "mime_type": "image/png",
        "size_bytes": 1234,
        "duration_seconds": 0,
        "created_at": "2026-08-17T10:00:00+00:00",
        "expires_at": None,
        "storage_provider": "r2",
        "status": "complete",
        "revoked": False,
        "view_count": 0,
        "download_count": 0,
        "client_id": "client-00000001",
    }
    row.update(overrides)
    fake_db.store.setdefault("captures", []).append(row)
    return row


def test_history_requires_client_id(fake_db, configured_settings):
    res = client.get("/api/media/history")
    assert res.status_code == 422


def test_history_returns_only_that_clients_completed_uploads(fake_db, configured_settings):
    _seed_complete_row(fake_db, share_id="mine-1", client_id="client-00000001")
    _seed_complete_row(fake_db, share_id="not-mine", client_id="client-99999999")
    _seed_complete_row(fake_db, share_id="mine-pending", client_id="client-00000001", status="pending")

    res = client.get("/api/media/history?client_id=client-00000001")
    assert res.status_code == 200
    ids = [item["id"] for item in res.json()]
    assert ids == ["mine-1"]  # excludes other clients and the still-pending upload


def test_media_detail_not_found(fake_db, configured_settings):
    res = client.get("/api/media/nonexistent-share-id")
    assert res.status_code == 404


def test_media_detail_returns_full_info(fake_db, configured_settings):
    _seed_complete_row(fake_db)
    res = client.get("/api/media/share-0001")
    assert res.status_code == 200
    body = res.json()
    assert body["storage_provider"] == "r2"
    assert body["content_type"] == "image/png"
    assert body["revoked"] is False


def test_revoke_marks_row_revoked(fake_db, configured_settings):
    _seed_complete_row(fake_db)
    res = client.post("/api/media/share-0001/revoke")
    assert res.status_code == 200
    assert fake_db.store["captures"][0]["revoked"] is True


def test_expire_sets_expires_at_from_hours(fake_db, configured_settings):
    _seed_complete_row(fake_db)
    res = client.post("/api/media/share-0001/expire", json={"hours": 24})
    assert res.status_code == 200
    assert fake_db.store["captures"][0]["expires_at"] is not None


def test_expire_with_null_hours_clears_expiration(fake_db, configured_settings):
    _seed_complete_row(fake_db, expires_at="2026-01-01T00:00:00+00:00")
    res = client.post("/api/media/share-0001/expire", json={})
    assert res.status_code == 200
    assert fake_db.store["captures"][0]["expires_at"] is None


def test_delete_removes_r2_object_and_db_row(fake_db, configured_settings, monkeypatch):
    _seed_complete_row(fake_db)
    deleted_keys = []
    monkeypatch.setattr(media_route.r2_storage, "delete_object", lambda key: deleted_keys.append(key))
    res = client.post("/api/media/share-0001/delete")
    assert res.status_code == 200
    assert deleted_keys == ["screenshots/c1/2026/08/uuid.png"]
    assert fake_db.store["captures"] == []


def test_delete_not_found(fake_db, configured_settings):
    res = client.post("/api/media/nonexistent/delete")
    assert res.status_code == 404


# ============================== /s/{share_id} viewer: availability + counters ==============================


def test_viewer_increments_view_count_on_each_load(fake_db, configured_settings, monkeypatch):
    _seed_complete_row(fake_db)
    monkeypatch.setattr("app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://r2.example/signed")
    res1 = client.get("/s/share-0001")
    assert res1.status_code == 200
    assert fake_db.store["captures"][0]["view_count"] == 1
    res2 = client.get("/s/share-0001")
    assert res2.status_code == 200
    assert fake_db.store["captures"][0]["view_count"] == 2


def test_viewer_shows_error_state_for_revoked_share(fake_db, configured_settings):
    _seed_complete_row(fake_db, revoked=True)
    res = client.get("/s/share-0001")
    assert res.status_code == 410
    assert b"revoked" in res.content.lower()


def test_viewer_shows_error_state_for_expired_share(fake_db, configured_settings):
    _seed_complete_row(fake_db, expires_at="2020-01-01T00:00:00+00:00")  # well in the past
    res = client.get("/s/share-0001")
    assert res.status_code == 410
    assert b"expired" in res.content.lower()


def test_viewer_shows_not_ready_for_still_pending_upload(fake_db, configured_settings):
    _seed_complete_row(fake_db, status="pending")
    res = client.get("/s/share-0001")
    assert res.status_code == 410
    assert b"progress" in res.content.lower()


def test_viewer_404_for_unknown_share(fake_db, configured_settings):
    res = client.get("/s/does-not-exist")
    assert res.status_code == 404


def test_viewer_still_works_normally_for_a_healthy_share(fake_db, configured_settings, monkeypatch):
    _seed_complete_row(fake_db)
    monkeypatch.setattr("app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://r2.example/signed")
    res = client.get("/s/share-0001")
    assert res.status_code == 200
    assert b"revoked" not in res.content.lower()


def test_download_route_increments_download_count_and_redirects(fake_db, configured_settings, monkeypatch):
    _seed_complete_row(fake_db)
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url",
        lambda key, expires_in=None: "https://r2.example/signed-download",
    )
    res = client.get("/s/share-0001/download", follow_redirects=False)
    assert res.status_code in (302, 307)
    assert res.headers["location"] == "https://r2.example/signed-download"
    assert fake_db.store["captures"][0]["download_count"] == 1


def test_download_route_blocked_for_revoked_share(fake_db, configured_settings):
    _seed_complete_row(fake_db, revoked=True)
    res = client.get("/s/share-0001/download", follow_redirects=False)
    assert res.status_code == 410
    assert fake_db.store["captures"][0]["download_count"] == 0


def test_api_share_info_returns_410_for_revoked(fake_db, configured_settings):
    _seed_complete_row(fake_db, revoked=True)
    res = client.get("/api/share/share-0001")
    assert res.status_code == 410
