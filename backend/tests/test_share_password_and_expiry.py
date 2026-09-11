"""
tests/test_share_password_and_expiry.py
Route-level tests for password-protected share links
(app/routes/share.py) and the org-wide DEFAULT_SHARE_EXPIRY_DAYS policy
(app/services/sharing.py, applied in app/routes/upload.py and
app/routes/media.py). Reuses the FakeSupabaseClient fixture pattern from
test_analytics.py / test_r2_media.py.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.services import share_security  # noqa: E402
from tests.test_analytics import FakeSupabaseClient  # noqa: E402

client = TestClient(app)


@pytest.fixture
def configured_settings(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "fake-key")
    yield settings


@pytest.fixture
def fake_db(monkeypatch):
    fake_client = FakeSupabaseClient()
    import app.services.storage as storage_service
    import app.routes.share as share_route

    monkeypatch.setattr(storage_service, "get_supabase_client", lambda: fake_client)
    # share.py no longer calls get_supabase_client() directly for file
    # URLs (it now uses generate_supabase_signed_read_url(), a signed URL
    # rather than get_public_url() -- see that function's docstring for
    # why get_public_url() was a real bug for private buckets). Mock that
    # function directly rather than the whole client chain behind it.
    monkeypatch.setattr(share_route, "generate_supabase_signed_read_url", lambda path, expires_in=None: f"https://cdn.example.com/{path}")

    yield fake_client


def _seed_row(fake_db, **overrides):
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
        "storage_provider": "supabase",
        "status": "complete",
        "revoked": False,
        "view_count": 0,
        "download_count": 0,
        "client_id": None,
        "password_hash": None,
    }
    row.update(overrides)
    fake_db.store.setdefault("captures", []).append(row)
    return row


# ============================== Setting a password ==============================


def test_set_password_on_unknown_share_returns_404(fake_db, configured_settings):
    res = client.post("/api/share/does-not-exist/password", json={"password": "secret123"})
    assert res.status_code == 404


def test_set_password_hashes_it_never_stores_plaintext(fake_db, configured_settings):
    _seed_row(fake_db)
    res = client.post("/api/share/share-0001/password", json={"password": "secret123"})
    assert res.status_code == 200
    assert res.json() == {"success": True, "password_protected": True}
    stored = fake_db.store["captures"][0]["password_hash"]
    assert stored is not None
    assert "secret123" not in stored  # never the plaintext
    assert share_security.verify_password("secret123", stored) is True


def test_clearing_password_with_null_removes_protection(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("old-password"))
    res = client.post("/api/share/share-0001/password", json={"password": None})
    assert res.status_code == 200
    assert res.json() == {"success": True, "password_protected": False}
    assert fake_db.store["captures"][0]["password_hash"] is None


# ============================== Viewer: password gate ==============================


def test_unprotected_share_viewer_works_normally(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db)
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    res = client.get("/s/share-0001")
    assert res.status_code == 200
    assert b"password-protected" not in res.content


def test_protected_share_viewer_shows_password_form_not_content(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    res = client.get("/s/share-0001")
    assert res.status_code == 401
    assert b"password-protected" in res.content
    assert b"secret123" not in res.content


def test_protected_share_view_count_does_not_increment_before_unlock(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    client.get("/s/share-0001")
    assert fake_db.store["captures"][0]["view_count"] == 0


def test_wrong_password_shows_error_and_still_no_content(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    res = client.post("/s/share-0001", data={"password": "wrong-guess"})
    assert res.status_code == 401
    assert b"Incorrect password" in res.content


def test_correct_password_unlocks_content_directly(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    res = client.post("/s/share-0001", data={"password": "secret123"})
    assert res.status_code == 200
    assert b"password-protected" not in res.content
    assert fake_db.store["captures"][0]["view_count"] == 1


def test_correct_password_response_embeds_a_download_token(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    res = client.post("/s/share-0001", data={"password": "secret123"})
    assert b"/s/share-0001/download?t=" in res.content


# ============================== Download: password/token gate ==============================


def test_download_without_token_is_blocked_on_a_protected_share(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    res = client.get("/s/share-0001/download", follow_redirects=False)
    assert res.status_code == 401
    assert fake_db.store["captures"][0]["download_count"] == 0


def test_download_with_valid_token_succeeds_on_a_protected_share(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    settings = get_settings()
    token = share_security.generate_download_token("share-0001", settings.effective_share_token_secret)
    res = client.get(f"/s/share-0001/download?t={token}", follow_redirects=False)
    assert res.status_code in (302, 307)
    assert fake_db.store["captures"][0]["download_count"] == 1


def test_download_with_token_for_a_different_share_is_rejected(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    settings = get_settings()
    token = share_security.generate_download_token("some-other-share", settings.effective_share_token_secret)
    res = client.get(f"/s/share-0001/download?t={token}", follow_redirects=False)
    assert res.status_code == 401


def test_download_unaffected_for_an_unprotected_share(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db)
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    res = client.get("/s/share-0001/download", follow_redirects=False)
    assert res.status_code in (302, 307)


# ============================== JSON API: password gate ==============================


def test_api_share_info_requires_password_when_protected(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    res = client.get("/api/share/share-0001")
    assert res.status_code == 401


def test_api_share_info_succeeds_with_correct_password_query_param(fake_db, configured_settings, monkeypatch):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    monkeypatch.setattr(
        "app.routes.share.r2_storage.generate_presigned_get_url", lambda key, expires_in=None: "https://example/signed"
    )
    res = client.get("/api/share/share-0001?password=secret123")
    assert res.status_code == 200


def test_api_share_info_fails_with_wrong_password_query_param(fake_db, configured_settings):
    _seed_row(fake_db, password_hash=share_security.hash_password("secret123"))
    res = client.get("/api/share/share-0001?password=wrong")
    assert res.status_code == 401


# ============================== Default org-wide expiry policy ==============================


def test_upload_without_default_policy_has_no_expiry(fake_db, configured_settings, monkeypatch):
    monkeypatch.setattr(configured_settings, "DEFAULT_SHARE_EXPIRY_DAYS", 0)
    monkeypatch.setattr(
        "app.routes.upload.upload_file_bytes", lambda path, data, mime: "https://cdn.example.com/" + path
    )
    import io
    res = client.post(
        "/api/upload",
        files={"file": ("shot.png", io.BytesIO(b"fake-png-bytes"), "image/png")},
        data={"type": "screenshot", "name": "shot.png", "mime_type": "image/png"},
    )
    assert res.status_code == 200
    assert fake_db.store["captures"][0]["expires_at"] is None


def test_upload_with_default_policy_sets_expiry_automatically(fake_db, configured_settings, monkeypatch):
    monkeypatch.setattr(configured_settings, "DEFAULT_SHARE_EXPIRY_DAYS", 30)
    monkeypatch.setattr(
        "app.routes.upload.upload_file_bytes", lambda path, data, mime: "https://cdn.example.com/" + path
    )
    import io
    res = client.post(
        "/api/upload",
        files={"file": ("shot.png", io.BytesIO(b"fake-png-bytes"), "image/png")},
        data={"type": "screenshot", "name": "shot.png", "mime_type": "image/png"},
    )
    assert res.status_code == 200
    assert fake_db.store["captures"][0]["expires_at"] is not None
