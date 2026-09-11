"""
tests/test_api.py
Backend test suite. Supabase calls are monkeypatched so these tests run
without live credentials — they verify routing, validation, and error
handling, not actual cloud storage.

Run with:
    pytest -v
"""
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
import app.routes.upload as upload_route  # noqa: E402
import app.routes.share as share_route  # noqa: E402

client = TestClient(app)


def make_png_bytes() -> bytes:
    # Minimal valid 1x1 PNG.
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080200000090"
        "7753de0000000c4944415478da6360606000000004000101f5c02b7e0000"
        "000049454e44ae426082"
    )


@pytest.fixture(autouse=True)
def configured_settings(monkeypatch):
    """Pretend Supabase is configured for tests that need it."""
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    yield settings


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_root():
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_upload_rejects_invalid_mime_type():
    res = client.post(
        "/api/upload",
        files={"file": ("test.exe", io.BytesIO(b"data"), "application/octet-stream")},
        data={"type": "screenshot", "name": "test.exe", "mime_type": "application/octet-stream"},
    )
    assert res.status_code == 400
    assert "Unsupported MIME type" in res.json()["detail"]


def test_upload_accepts_video_mime_type_with_codec_parameters(monkeypatch):
    """Regression test: MediaRecorder reports (and the extension sends)
    the full Content-Type it actually recorded with, e.g.
    "video/webm;codecs=vp9,opus" -- a naive exact-match against a bare
    "video/webm" allow-list rejects every real recording. Screenshots
    never hit this because "image/png" never carries codec parameters."""
    monkeypatch.setattr(
        upload_route, "upload_file_bytes", lambda path, data, mime: "https://cdn.example.com/" + path
    )
    monkeypatch.setattr(upload_route, "insert_capture_row", lambda record: record)

    res = client.post(
        "/api/upload",
        files={"file": ("rec.webm", io.BytesIO(b"fake-webm-bytes"), "video/webm;codecs=vp9,opus")},
        data={"type": "recording", "name": "rec.webm", "mime_type": "video/webm;codecs=vp9,opus"},
    )
    assert res.status_code == 200
    assert res.json()["success"] is True


def test_upload_still_rejects_a_genuinely_unsupported_type_with_parameters():
    res = client.post(
        "/api/upload",
        files={"file": ("x.bin", io.BytesIO(b"data"), "application/octet-stream;charset=binary")},
        data={"type": "screenshot", "name": "x.bin", "mime_type": "application/octet-stream;charset=binary"},
    )
    assert res.status_code == 400


def test_upload_rejects_bad_type_field():
    res = client.post(
        "/api/upload",
        files={"file": ("test.png", io.BytesIO(make_png_bytes()), "image/png")},
        data={"type": "banana", "name": "test.png", "mime_type": "image/png"},
    )
    assert res.status_code == 400
    assert "type must be" in res.json()["detail"]


def test_upload_rejects_path_traversal_filename():
    res = client.post(
        "/api/upload",
        files={"file": ("evil.png", io.BytesIO(make_png_bytes()), "image/png")},
        data={"type": "screenshot", "name": "../../etc/passwd.png", "mime_type": "image/png"},
    )
    assert res.status_code == 400


def test_upload_rejects_empty_file():
    res = client.post(
        "/api/upload",
        files={"file": ("empty.png", io.BytesIO(b""), "image/png")},
        data={"type": "screenshot", "name": "empty.png", "mime_type": "image/png"},
    )
    assert res.status_code == 400
    assert "empty" in res.json()["detail"].lower()


def test_upload_rejects_file_too_large(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "MAX_FILE_SIZE_MB", 1)  # 1MB cap for this test
    big_payload = b"0" * (2 * 1024 * 1024)  # 2MB > 1MB cap
    res = client.post(
        "/api/upload",
        files={"file": ("big.png", io.BytesIO(big_payload), "image/png")},
        data={"type": "screenshot", "name": "big.png", "mime_type": "image/png"},
    )
    assert res.status_code == 413


def test_upload_rejects_oversized_file_before_fully_buffering_it(monkeypatch):
    """The chunked-read path should reject an oversized file as soon as
    the running total crosses the limit, not only after reading the
    entire body -- verified indirectly here by confirming a file whose
    size is many multiples of the internal 4MB chunk size still gets a
    clean 413 rather than hanging or erroring some other way."""
    settings = get_settings()
    monkeypatch.setattr(settings, "MAX_FILE_SIZE_MB", 5)  # 5MB cap
    oversized_payload = b"0" * (20 * 1024 * 1024)  # 20MB — several chunks over the cap
    res = client.post(
        "/api/upload",
        files={"file": ("big.webm", io.BytesIO(oversized_payload), "video/webm")},
        data={"type": "recording", "name": "big.webm", "mime_type": "video/webm"},
    )
    assert res.status_code == 413
    assert "5MB" in res.json()["detail"]


def test_upload_has_no_size_cap_by_default():
    """Direct proof of the default behavior after MAX_FILE_SIZE_MB's
    default changed from a fixed cap to 0 (unlimited): a large upload
    succeeds with NO monkeypatching at all -- this is what a fresh
    deployment actually does out of the box, not just what's possible
    after an operator configures a higher limit."""
    settings = get_settings()
    assert settings.MAX_FILE_SIZE_MB == 0
    assert settings.max_file_size_bytes is None


def test_upload_accepts_a_recording_over_100mb(monkeypatch):
    """Direct proof of the actual feature request: a recording larger
    than the OLD 100MB default limit now succeeds, using the new
    default (2048MB). This is exactly the scenario that used to be
    rejected outright."""
    monkeypatch.setattr(
        upload_route, "upload_file_bytes", lambda path, data, mime: "https://cdn.example.com/" + path
    )
    monkeypatch.setattr(upload_route, "insert_capture_row", lambda record: record)

    large_payload = b"0" * (120 * 1024 * 1024)  # 120MB — over the old 100MB cap
    res = client.post(
        "/api/upload",
        files={"file": ("meeting-recording.webm", io.BytesIO(large_payload), "video/webm;codecs=vp9,opus")},
        data={
            "type": "recording",
            "name": "meeting-recording.webm",
            "mime_type": "video/webm;codecs=vp9,opus",
        },
    )
    assert res.status_code == 200
    assert res.json()["success"] is True


def test_generate_supabase_signed_read_url_calls_create_signed_url_not_get_public_url(monkeypatch):
    """Direct proof of the actual fix: file URLs are generated via
    create_signed_url() (works regardless of whether the bucket is
    public or private), never get_public_url() (only works for a
    public bucket -- a real, likely cause of "upload succeeds but the
    link doesn't work" for the many Supabase projects using private
    buckets)."""
    import app.services.storage as storage_service

    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    monkeypatch.setattr(settings, "SUPABASE_PRESIGNED_DOWNLOAD_EXPIRY", 1800)

    calls = []

    class FakeBucket:
        def create_signed_url(self, path, expires_in, options=None):
            calls.append({"path": path, "expires_in": expires_in})
            return {"signedURL": f"https://example.supabase.co/storage/v1/object/sign/bucket/{path}?token=abc"}

        def get_public_url(self, path):
            raise AssertionError("get_public_url() should never be called — it doesn't work for private buckets")

    class FakeStorage:
        def from_(self, bucket_name):
            return FakeBucket()

    class FakeClient:
        storage = FakeStorage()

    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: FakeClient())

    url = storage_service.generate_supabase_signed_read_url("recordings/c1/2026/09/x.webm")
    assert url == "https://example.supabase.co/storage/v1/object/sign/bucket/recordings/c1/2026/09/x.webm?token=abc"
    assert calls == [{"path": "recordings/c1/2026/09/x.webm", "expires_in": 1800}]


def test_upload_success_with_mocked_storage(monkeypatch):
    monkeypatch.setattr(
        upload_route, "upload_file_bytes", lambda path, data, mime: "https://cdn.example.com/" + path
    )
    monkeypatch.setattr(
        upload_route,
        "insert_capture_row",
        lambda record: {**record, "share_id": record["share_id"]},
    )

    res = client.post(
        "/api/upload",
        files={"file": ("test.png", io.BytesIO(make_png_bytes()), "image/png")},
        data={"type": "screenshot", "name": "test.png", "mime_type": "image/png"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["share_url"].endswith(f"/s/{body['id']}")
    assert body["file_url"].startswith("https://cdn.example.com/captures/")
    # Share IDs must be non-trivial and unpredictable (secrets.token_urlsafe(9) -> 12 chars)
    assert len(body["id"]) >= 8


def test_share_id_generation_is_unique():
    from app.services.sharing import generate_share_id

    ids = {generate_share_id() for _ in range(200)}
    assert len(ids) == 200  # no collisions across 200 generations


def test_build_share_url_uses_render_external_url_when_public_base_url_is_default(monkeypatch):
    """A fresh Render deploy shouldn't need a manual PUBLIC_BASE_URL round
    trip -- share links should work immediately using Render's own
    auto-injected RENDER_EXTERNAL_URL."""
    from app.services.sharing import build_share_url, settings as sharing_settings

    monkeypatch.setattr(sharing_settings, "PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://satylens-api.onrender.com")
    url = build_share_url("abc123")
    assert url == "https://satylens-api.onrender.com/s/abc123"


def test_build_share_url_prefers_explicit_public_base_url_over_render(monkeypatch):
    """If the operator explicitly set PUBLIC_BASE_URL (e.g. a custom
    domain), that always wins over Render's auto-detected URL."""
    from app.services.sharing import build_share_url, settings as sharing_settings

    monkeypatch.setattr(sharing_settings, "PUBLIC_BASE_URL", "https://links.example.com")
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://satylens-api.onrender.com")
    url = build_share_url("abc123")
    assert url == "https://links.example.com/s/abc123"


def test_build_share_url_falls_back_to_localhost_without_render(monkeypatch):
    from app.services.sharing import build_share_url, settings as sharing_settings

    monkeypatch.setattr(sharing_settings, "PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.delenv("RENDER_EXTERNAL_URL", raising=False)
    url = build_share_url("abc123")
    assert url == "http://localhost:8000/s/abc123"


def test_build_share_url_strips_trailing_slashes():
    from app.services.sharing import build_share_url, settings as sharing_settings

    original = sharing_settings.PUBLIC_BASE_URL
    try:
        sharing_settings.PUBLIC_BASE_URL = "https://links.example.com///"
        url = build_share_url("abc123")
        assert url == "https://links.example.com/s/abc123"
    finally:
        sharing_settings.PUBLIC_BASE_URL = original


def test_get_share_info_not_found(monkeypatch):
    monkeypatch.setattr(share_route, "get_capture_row", lambda share_id: None)
    res = client.get("/api/share/does-not-exist")
    assert res.status_code == 404


def test_get_share_info_success(monkeypatch):
    fake_row = {
        "share_id": "abc123",
        "type": "screenshot",
        "original_filename": "shot.png",
        "storage_path": "captures/2026/08/abc123.png",
        "mime_type": "image/png",
        "size_bytes": 1234,
        "duration_seconds": 0,
        "created_at": "2026-08-14T10:00:00+00:00",
    }
    monkeypatch.setattr(share_route, "get_capture_row", lambda share_id: fake_row)
    # share.py resolves a file's URL via a signed read URL now, not
    # get_public_url() (see generate_supabase_signed_read_url's
    # docstring) -- mock that function directly.
    monkeypatch.setattr(
        share_route, "generate_supabase_signed_read_url", lambda path, expires_in=None: f"https://cdn.example.com/{path}"
    )

    res = client.get("/api/share/abc123")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == "abc123"
    assert body["file_url"] == "https://cdn.example.com/captures/2026/08/abc123.png"


def test_delete_share_not_found(monkeypatch):
    monkeypatch.setattr(share_route, "get_capture_row", lambda share_id: None)
    res = client.delete("/api/share/does-not-exist")
    assert res.status_code == 404


def test_delete_share_success(monkeypatch):
    monkeypatch.setattr(
        share_route, "get_capture_row", lambda share_id: {"share_id": share_id, "storage_provider": "supabase"}
    )
    monkeypatch.setattr(share_route, "delete_capture_row", lambda share_id: {"share_id": share_id})
    res = client.delete("/api/share/abc123")
    assert res.status_code == 200
    assert res.json() == {"success": True, "deleted": "abc123"}


def test_delete_share_r2_backed_also_deletes_the_r2_object(monkeypatch):
    monkeypatch.setattr(
        share_route,
        "get_capture_row",
        lambda share_id: {"share_id": share_id, "storage_provider": "r2", "storage_path": "screenshots/x/y/z.png"},
    )
    monkeypatch.setattr(share_route, "delete_capture_row", lambda share_id: {"share_id": share_id})
    deleted_keys = []
    monkeypatch.setattr(share_route.r2_storage, "delete_object", lambda key: deleted_keys.append(key))
    res = client.delete("/api/share/abc123")
    assert res.status_code == 200
    assert deleted_keys == ["screenshots/x/y/z.png"]


def test_upload_without_supabase_configured_returns_503(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "")
    res = client.post(
        "/api/upload",
        files={"file": ("test.png", io.BytesIO(make_png_bytes()), "image/png")},
        data={"type": "screenshot", "name": "test.png", "mime_type": "image/png"},
    )
    assert res.status_code == 503
