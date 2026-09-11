"""
tests/test_share_security.py
Unit tests for password hashing and download-token signing --
app/services/share_security.py. Pure functions, no mocking needed.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.share_security import (  # noqa: E402
    hash_password,
    verify_password,
    generate_download_token,
    verify_download_token,
)


def test_correct_password_verifies():
    h = hash_password("correct-horse-battery-staple")
    assert verify_password("correct-horse-battery-staple", h) is True


def test_wrong_password_does_not_verify():
    h = hash_password("correct-horse-battery-staple")
    assert verify_password("wrong-password", h) is False


def test_empty_password_does_not_verify_against_a_real_hash():
    h = hash_password("correct-horse-battery-staple")
    assert verify_password("", h) is False


def test_same_password_hashed_twice_produces_different_hashes():
    h1 = hash_password("same-password")
    h2 = hash_password("same-password")
    assert h1 != h2  # random salt each time
    assert verify_password("same-password", h1) is True
    assert verify_password("same-password", h2) is True


def test_malformed_hash_does_not_crash_or_verify():
    assert verify_password("anything", "not-a-valid-hash-format") is False
    assert verify_password("anything", "") is False
    assert verify_password("anything", "no-dollar-sign-here") is False


def test_valid_download_token_verifies():
    token = generate_download_token("share-abc", "secret")
    assert verify_download_token("share-abc", token, "secret") is True


def test_token_does_not_verify_for_a_different_share_id():
    token = generate_download_token("share-abc", "secret")
    assert verify_download_token("share-XYZ", token, "secret") is False


def test_token_does_not_verify_with_wrong_secret():
    token = generate_download_token("share-abc", "secret")
    assert verify_download_token("share-abc", token, "wrong-secret") is False


def test_malformed_or_empty_token_does_not_crash_or_verify():
    assert verify_download_token("share-abc", "garbage.token", "secret") is False
    assert verify_download_token("share-abc", "", "secret") is False
    assert verify_download_token("share-abc", "no-dot-separator", "secret") is False


def test_expired_token_does_not_verify():
    expired = generate_download_token("share-abc", "secret", ttl_seconds=-10)
    assert verify_download_token("share-abc", expired, "secret") is False


def test_token_within_ttl_still_verifies():
    token = generate_download_token("share-abc", "secret", ttl_seconds=5)
    time.sleep(0.1)
    assert verify_download_token("share-abc", token, "secret") is True
