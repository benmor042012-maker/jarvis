from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from server.config import Settings
from server.logging_utils import redact
from server.main import create_app


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))


def test_health_reports_mock_mode(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["mock_mode"] is True


def test_command_returns_validated_plan(client: TestClient) -> None:
    r = client.post("/api/command", json={"command": "launch notepad"})
    assert r.status_code == 200
    body = r.json()
    assert body["actions"][0]["type"] == "open_app"
    assert body["actions"][0]["risk"] == "medium"
    assert body["requires_confirmation"] is True


def test_command_validation_error_is_helpful(client: TestClient) -> None:
    r = client.post("/api/command", json={"command": ""})
    assert r.status_code == 422


def test_execute_without_confirmation_is_409(client: TestClient) -> None:
    r = client.post("/api/execute", json={"actions": [{"type": "create_text_file", "payload": {"path": "x.txt", "content": ""}, "risk": "low"}], "confirmed": False})
    assert r.status_code == 409
    assert r.json()["error"] == "confirmation_required"


def test_execute_unknown_action_type_is_422(client: TestClient) -> None:
    r = client.post("/api/execute", json={"actions": [{"type": "run_shell", "payload": {"cmd": "ls"}, "risk": "low"}], "confirmed": True})
    assert r.status_code == 422


def test_execute_blocked_url_is_403(client: TestClient) -> None:
    r = client.post("/api/execute", json={"actions": [{"type": "open_url", "payload": {"url": "https://evil.example"}, "risk": "low"}], "confirmed": True})
    assert r.status_code == 403


def test_execute_job_lifecycle(client: TestClient) -> None:
    r = client.post(
        "/api/execute",
        json={"actions": [{"type": "create_text_file", "payload": {"path": "hello.txt", "content": "hi"}, "risk": "medium"}], "confirmed": True},
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    for _ in range(100):
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.02)
    assert j["status"] == "done" and j["results"][0]["ok"] is True
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 200


def test_settings_never_expose_the_key(client: TestClient) -> None:
    r = client.put("/api/settings", json={"api_key": "sk-secretsecretsecret1234", "model": "gpt-x"})
    assert r.status_code == 200
    body = r.json()
    assert "api_key" not in body
    assert body["has_api_key"] is True
    assert body["api_key_hint"] == "••••1234"
    assert "secret" not in r.text
    # clearing
    body = client.put("/api/settings", json={"api_key": ""}).json()
    assert body["has_api_key"] is False and body["api_key_hint"] == ""


def test_settings_persist_only_non_secret_fields(client: TestClient, tmp_path) -> None:
    client.put("/api/settings", json={"api_key": "sk-secretsecretsecret1234", "permission_mode": "auto"})
    text = (tmp_path / "data" / "settings.json").read_text()
    assert "secret" not in text and '"permission_mode": "auto"' in text


def test_connection_test_in_mock_mode(client: TestClient) -> None:
    assert client.post("/api/settings/test").json()["status"] == "mock"


def test_connection_test_missing_key(client: TestClient, settings: Settings) -> None:
    settings.force_mock = False
    assert client.post("/api/settings/test").json()["status"] == "missing_key"


def test_log_redaction() -> None:
    out = redact({"api_key": "abc", "nested": {"Authorization": "Bearer xyz"}, "text": "key sk-abcdefghijklmnop here"})
    assert out["api_key"] == "***" and out["nested"]["Authorization"] == "***" and "sk-abc" not in out["text"]
