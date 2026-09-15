"""Typed API schemas. Every request and response crossing the wire is validated here.

The model provider may only ever return data that fits ``PlanResponse``;
free-form code or unknown action types are rejected before anything runs.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Risk(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class PermissionMode(str, Enum):
    """How much the assistant may do without asking.

    manual  - every action needs confirmation.
    ask     - low-risk actions run automatically, medium/high ask (default).
    auto    - low and medium run automatically, high still asks.
    """

    manual = "manual"
    ask = "ask"
    auto = "auto"


class ActionType(str, Enum):
    open_url = "open_url"
    open_app = "open_app"
    search_files = "search_files"
    read_text_file = "read_text_file"
    create_text_file = "create_text_file"


ALLOWED_ACTION_TYPES: frozenset[str] = frozenset(a.value for a in ActionType)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --- payloads ---------------------------------------------------------------


class OpenUrlPayload(_Strict):
    url: str = Field(min_length=1, max_length=2048)


class OpenAppPayload(_Strict):
    app: str = Field(min_length=1, max_length=64, description="Allowlisted app id, e.g. 'notepad'")


class SearchFilesPayload(_Strict):
    query: str = Field(min_length=1, max_length=200)
    max_results: int = Field(default=50, ge=1, le=500)


class ReadTextFilePayload(_Strict):
    path: str = Field(min_length=1, max_length=1024, description="Path relative to the workspace")


class CreateTextFilePayload(_Strict):
    path: str = Field(min_length=1, max_length=1024, description="Path relative to the workspace")
    content: str = Field(default="", max_length=200_000)


# --- actions (discriminated union on ``type``) ------------------------------


class _ActionBase(_Strict):
    risk: Risk = Risk.low


class OpenUrlAction(_ActionBase):
    type: Literal["open_url"]
    payload: OpenUrlPayload


class OpenAppAction(_ActionBase):
    type: Literal["open_app"]
    payload: OpenAppPayload


class SearchFilesAction(_ActionBase):
    type: Literal["search_files"]
    payload: SearchFilesPayload


class ReadTextFileAction(_ActionBase):
    type: Literal["read_text_file"]
    payload: ReadTextFilePayload


class CreateTextFileAction(_ActionBase):
    type: Literal["create_text_file"]
    payload: CreateTextFilePayload


Action = Annotated[
    OpenUrlAction | OpenAppAction | SearchFilesAction | ReadTextFileAction | CreateTextFileAction,
    Field(discriminator="type"),
]


# --- planning ---------------------------------------------------------------


class PlanResponse(_Strict):
    """What the assistant proposes. This is the only shape a provider may return."""

    message: str = Field(max_length=4000)
    requires_confirmation: bool = False
    actions: list[Action] = Field(default_factory=list, max_length=10)
    plan_id: str | None = None
    provider: str | None = None


class CommandRequest(_Strict):
    command: str = Field(min_length=1, max_length=2000)

    @field_validator("command")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("command must not be blank")
        return v


# --- execution --------------------------------------------------------------


class ExecuteRequest(_Strict):
    actions: list[Action] = Field(min_length=1, max_length=10)
    confirmed: bool = False


class ActionResult(_Strict):
    type: ActionType
    ok: bool
    summary: str
    data: dict[str, object] = Field(default_factory=dict)


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    cancelled = "cancelled"
    failed = "failed"


class JobView(_Strict):
    job_id: str
    status: JobStatus
    results: list[ActionResult] = Field(default_factory=list)
    error: str | None = None
    total: int
    completed: int


# --- settings ---------------------------------------------------------------


class SettingsView(_Strict):
    """Never carries the key itself, only whether one is set and a masked hint."""

    provider: str
    model: str
    base_url: str
    workspace_dir: str
    permission_mode: PermissionMode
    has_api_key: bool
    api_key_hint: str
    mock_mode: bool
    allowed_url_hosts: list[str]
    allowed_apps: list[str]


class SettingsUpdate(_Strict):
    provider: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=128)
    base_url: str | None = Field(default=None, max_length=512)
    workspace_dir: str | None = Field(default=None, max_length=1024)
    permission_mode: PermissionMode | None = None
    api_key: str | None = Field(default=None, max_length=512, description="Write-only. Empty string clears.")


class ConnectionStatus(str, Enum):
    connected = "connected"
    missing_key = "missing_key"
    invalid_key = "invalid_key"
    error = "error"
    mock = "mock"


class ConnectionTestResult(_Strict):
    status: ConnectionStatus
    detail: str


class ErrorResponse(_Strict):
    error: str
    detail: str | None = None


class HealthResponse(_Strict):
    ok: bool
    version: str
    mock_mode: bool
