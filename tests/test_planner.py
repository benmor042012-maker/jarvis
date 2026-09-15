from __future__ import annotations

import pytest

from server.action_planner import plan_command
from server.config import Settings
from server.model_provider import MockProvider, ProviderError, parse_plan
from server.schemas import PermissionMode, PlanResponse, Risk


class _FakeProvider:
    name = "fake"

    def __init__(self, plan: PlanResponse) -> None:
        self._plan = plan

    def plan(self, command: str) -> PlanResponse:
        return self._plan

    def test_connection(self):  # pragma: no cover - not used
        raise NotImplementedError


# --- mock provider understands natural commands ---------------------------------


@pytest.mark.parametrize(
    ("command", "action_type"),
    [
        ("open youtube", "open_url"),
        ("go to github.com", "open_url"),
        ("launch notepad", "open_app"),
        ("open the calculator", "open_app"),
        ("search for report", "search_files"),
        ("find files named invoice in my workspace", "search_files"),
        ("read file notes.txt", "read_text_file"),
        ("create file todo.txt with buy milk", "create_text_file"),
    ],
)
def test_mock_maps_commands_to_actions(settings: Settings, command: str, action_type: str) -> None:
    plan = plan_command(command, settings, MockProvider())
    assert [a.type for a in plan.actions] == [action_type]
    assert plan.plan_id and plan.provider == "mock"


def test_mock_create_file_keeps_content_case() -> None:
    plan = MockProvider().plan("create file Hello.txt with Dear Team, see attached")
    assert plan.actions[0].payload.path == "hello.txt"
    assert plan.actions[0].payload.content == "Dear Team, see attached"


@pytest.mark.parametrize("command", ["delete all my files", "send an email to bob", "what is my password", "sudo rm -rf /"])
def test_mock_refuses_unsafe_requests(settings: Settings, command: str) -> None:
    plan = plan_command(command, settings, MockProvider())
    assert plan.actions == []
    assert plan.message


def test_conversation_returns_no_actions(settings: Settings) -> None:
    plan = plan_command("hello there", settings, MockProvider())
    assert plan.actions == [] and plan.requires_confirmation is False


# --- planner enforces policy over whatever the provider says ----------------------


def test_planner_overrides_risk_and_sets_confirmation(settings: Settings) -> None:
    raw = PlanResponse.model_validate({"message": "x", "requires_confirmation": False, "actions": [{"type": "open_app", "payload": {"app": "notepad"}, "risk": "low"}]})
    plan = plan_command("whatever", settings, _FakeProvider(raw))
    assert plan.actions[0].risk is Risk.medium
    assert plan.requires_confirmation is True  # ask mode + medium risk


def test_planner_auto_mode_skips_confirmation_for_medium(settings: Settings) -> None:
    settings.permission_mode = PermissionMode.auto
    raw = PlanResponse.model_validate({"message": "x", "actions": [{"type": "open_app", "payload": {"app": "notepad"}, "risk": "low"}]})
    assert plan_command("x", settings, _FakeProvider(raw)).requires_confirmation is False


def test_planner_drops_disallowed_actions_and_explains(settings: Settings) -> None:
    raw = PlanResponse.model_validate(
        {
            "message": "sure",
            "actions": [
                {"type": "open_url", "payload": {"url": "https://evil.example"}, "risk": "low"},
                {"type": "read_text_file", "payload": {"path": "../../etc/passwd"}, "risk": "low"},
                {"type": "open_url", "payload": {"url": "https://github.com"}, "risk": "low"},
            ],
        }
    )
    plan = plan_command("x", settings, _FakeProvider(raw))
    assert [a.type for a in plan.actions] == ["open_url"]
    assert plan.actions[0].payload.url == "https://github.com"
    assert "Blocked" in plan.message and "evil.example" in plan.message


def test_planner_caps_to_five_actions(settings: Settings) -> None:
    raw = PlanResponse.model_validate({"message": "x", "actions": [{"type": "open_url", "payload": {"url": "https://github.com"}, "risk": "low"}] * 8})
    assert len(plan_command("x", settings, _FakeProvider(raw)).actions) == 5


# --- parsing model output ----------------------------------------------------------


def test_parse_plan_accepts_fenced_json() -> None:
    plan = parse_plan('```json\n{"message":"hi","requires_confirmation":false,"actions":[]}\n```')
    assert plan.message == "hi"


@pytest.mark.parametrize(
    "text",
    [
        "I will now run `rm -rf /`",
        "{not json",
        '{"message":"x","actions":[{"type":"run_shell","payload":{"cmd":"ls"},"risk":"low"}]}',
        '{"message":"x","actions":[{"type":"open_url","payload":{"url":"https://a.com"},"risk":"low","code":"x"}]}',
        "[1,2,3]",
    ],
)
def test_parse_plan_rejects_non_schema_output(text: str) -> None:
    with pytest.raises(ProviderError):
        parse_plan(text)


def test_provider_error_never_contains_key_material() -> None:
    from server.model_provider import OpenAICompatibleProvider

    msg = OpenAICompatibleProvider._safe_error(400, "bad request: Authorization: Bearer sk-abcdefghijklmnop123456 was rejected")
    assert "sk-abcdef" not in msg and "***" in msg
