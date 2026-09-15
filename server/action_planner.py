"""Turn a command into a validated, policy-checked plan."""

from __future__ import annotations

import uuid

from .config import Settings
from .model_provider import ModelProvider, get_provider
from .permissions import effective_risk, plan_requires_confirmation, resolve_app_command, resolve_workspace_path, validate_url
from .schemas import Action, PlanResponse

MAX_ACTIONS = 5


def validate_action(action: Action, settings: Settings) -> None:
    """Raise ``PermissionError`` if the action can never be allowed."""
    if action.type == "open_url":
        validate_url(action.payload.url, settings.allowed_url_hosts)
    elif action.type == "open_app":
        resolve_app_command(action.payload.app)
    elif action.type in ("read_text_file", "create_text_file"):
        resolve_workspace_path(settings.workspace, action.payload.path)
    # search_files: query is free text but only ever matched against names inside the workspace.


def plan_command(command: str, settings: Settings, provider: ModelProvider | None = None) -> PlanResponse:
    provider = provider or get_provider(settings)
    plan = provider.plan(command)

    actions: list[Action] = []
    blocked: list[str] = []
    for action in plan.actions[:MAX_ACTIONS]:
        try:
            validate_action(action, settings)
        except PermissionError as exc:
            blocked.append(f"{action.type}: {exc}")
            continue
        # Server policy owns risk. Copy with the effective value.
        actions.append(action.model_copy(update={"risk": effective_risk(action)}))

    message = plan.message.strip() or ("Done." if actions else "I have nothing to do for that.")
    if blocked:
        message += " Blocked: " + " ".join(blocked)

    return PlanResponse(
        message=message,
        requires_confirmation=plan_requires_confirmation(actions, settings.permission_mode),
        actions=actions,
        plan_id=uuid.uuid4().hex,
        provider=provider.name,
    )
