from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from server.schemas import ALLOWED_ACTION_TYPES, Action, CommandRequest, ExecuteRequest, PlanResponse

_action = TypeAdapter(Action)


def test_allowlist_is_exactly_the_five_safe_actions() -> None:
    assert ALLOWED_ACTION_TYPES == {"open_url", "open_app", "search_files", "read_text_file", "create_text_file"}


def test_valid_plan_round_trips() -> None:
    plan = PlanResponse.model_validate(
        {
            "message": "ok",
            "requires_confirmation": True,
            "actions": [{"type": "open_url", "payload": {"url": "https://github.com"}, "risk": "low"}],
        }
    )
    assert plan.actions[0].type == "open_url"
    assert plan.actions[0].payload.url == "https://github.com"


@pytest.mark.parametrize(
    "bad",
    [
        {"type": "run_shell", "payload": {"cmd": "rm -rf /"}, "risk": "low"},
        {"type": "delete_file", "payload": {"path": "x"}, "risk": "high"},
        {"type": "open_url", "payload": {"url": "https://a.com", "extra": 1}, "risk": "low"},
        {"type": "open_url", "payload": {}, "risk": "low"},
        {"type": "create_text_file", "payload": {"path": "a.txt"}, "risk": "ultra"},
        {"type": "search_files", "payload": {"query": "x", "max_results": 100000}, "risk": "low"},
    ],
)
def test_unknown_or_malformed_actions_are_rejected(bad: dict) -> None:
    with pytest.raises(ValidationError):
        _action.validate_python(bad)


def test_plan_caps_action_count() -> None:
    actions = [{"type": "open_url", "payload": {"url": "https://github.com"}, "risk": "low"}] * 11
    with pytest.raises(ValidationError):
        PlanResponse.model_validate({"message": "m", "actions": actions})


def test_command_must_not_be_blank() -> None:
    with pytest.raises(ValidationError):
        CommandRequest(command="   ")
    assert CommandRequest(command="  open youtube ").command == "open youtube"


def test_execute_requires_at_least_one_action() -> None:
    with pytest.raises(ValidationError):
        ExecuteRequest(actions=[], confirmed=True)


def test_plan_rejects_unknown_top_level_fields() -> None:
    with pytest.raises(ValidationError):
        PlanResponse.model_validate({"message": "m", "actions": [], "code": "print(1)"})
