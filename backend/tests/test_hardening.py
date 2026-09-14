import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import get_settings
from app.models.analytics import EventIn
from app.routes import share

@pytest.mark.parametrize('path', [
    '/api/analytics/overview', '/api/analytics/users', '/api/analytics/user/test-client',
    '/api/analytics/features', '/api/analytics/activity', '/api/analytics/timeseries?metric=dau',
])
def test_reporting_disabled_without_configured_secret(monkeypatch, path):
    monkeypatch.setattr(get_settings(), 'ANALYTICS_DASHBOARD_TOKEN', '')
    response = TestClient(app).get(path)
    assert response.status_code == 503
    assert 'disabled' in response.json()['detail']

@pytest.mark.parametrize('value', [
    'https://private.example/path?token=secret', 'password=private', 'Patient Alice report.png',
])
def test_ingestion_drops_private_error_text(value):
    event = EventIn(client_id='test-client', session_id='test-session',
                    event_type='ERROR_OCCURRED', error_message=value)
    assert event.error_message == 'operation_failed'


def test_r2_delete_failure_preserves_metadata_for_retry(monkeypatch):
    monkeypatch.setattr(get_settings(), 'SUPABASE_URL', 'https://example.supabase.co')
    monkeypatch.setattr(get_settings(), 'SUPABASE_SERVICE_ROLE_KEY', 'test-key')
    monkeypatch.setattr(share, 'get_capture_row', lambda _: {'storage_provider': 'r2', 'storage_path': 'object'})
    def fail(_):
        raise RuntimeError('provider failure with secret details')
    monkeypatch.setattr(share.r2_storage, 'delete_object', fail)
    deleted = []
    monkeypatch.setattr(share, 'delete_capture_row', deleted.append)
    response = TestClient(app).delete('/api/share/existing')
    assert response.status_code == 502
    assert deleted == []
    assert 'secret' not in response.text
