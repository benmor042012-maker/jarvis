from __future__ import annotations

import pytest
from pydantic import TypeAdapter

from server.permissions import (
    ALLOWED_APPS,
    effective_risk,
    needs_confirmation,
    plan_requires_confirmation,
    resolve_app_command,
    validate_url,
)
from server.schemas import Action, PermissionMode, Risk

_action = TypeAdapter(Action)


def _a(t: str, payload: dict, risk: str = "low"):
    return _action.validate_python({"type": t, "payload": payload, "risk": risk})


# --- risk policy ----------------------------------------------------------------


def test_server_policy_risk_cannot_be_lowered_by_model() -> None:
    a = _a("create_text_file", {"path": "x.txt"}, risk="low")
    assert effective_risk(a) is Risk.medium


def test_model_may_raise_risk() -> None:
    a = _a("open_url", {"url": "https://github.com"}, risk="high")
    assert effective_risk(a) is Risk.high


@pytest.mark.parametrize(
    ("risk", "mode", "expected"),
    [
        (Risk.low, PermissionMode.manual, True),
        (Risk.low, PermissionMode.ask, False),
        (Risk.medium, PermissionMode.ask, True),
        (Risk.high, PermissionMode.ask, True),
        (Risk.low, PermissionMode.auto, False),
        (Risk.medium, PermissionMode.auto, False),
        (Risk.high, PermissionMode.auto, True),
    ],
)
def test_needs_confirmation_matrix(risk: Risk, mode: PermissionMode, expected: bool) -> None:
    assert needs_confirmation(risk, mode) is expected


def test_plan_requires_confirmation_if_any_action_does() -> None:
    actions = [_a("open_url", {"url": "https://github.com"}), _a("open_app", {"app": "notepad"})]
    assert plan_requires_confirmation(actions, PermissionMode.ask) is True
    assert plan_requires_confirmation(actions[:1], PermissionMode.ask) is False


# --- urls -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    ["https://github.com", "github.com/anthropics", "https://www.youtube.com/watch?v=x", "http://localhost:5173/"],
)
def test_allowed_urls(url: str) -> None:
    assert validate_url(url).startswith("http")


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://evil.com",
        "https://github.com.evil.com",
        "https://user:pw@github.com",
        "ftp://github.com",
        "https://",
    ],
)
def test_blocked_urls(url: str) -> None:
    with pytest.raises(PermissionError):
        validate_url(url)


def test_custom_host_allowlist() -> None:
    assert validate_url("https://intranet.local/x", ("intranet.local",))
    with pytest.raises(PermissionError):
        validate_url("https://github.com", ("intranet.local",))


# --- apps -------------------------------------------------------------------------


def test_allowed_apps_resolve_to_fixed_argv() -> None:
    for app in ALLOWED_APPS:
        argv = resolve_app_command(app)
        assert isinstance(argv, list) and argv


@pytest.mark.parametrize("app", ["bash", "powershell", "notepad; rm -rf /", "regedit", ""])
def test_unknown_apps_are_blocked(app: str) -> None:
    with pytest.raises(PermissionError):
        resolve_app_command(app)
