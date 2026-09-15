"""Allowlists, risk policy, URL validation and workspace path safety.

Everything in here is enforced on the server. The UI mirrors it for a good
experience, but the UI is never the thing that keeps the machine safe.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from .schemas import Action, ActionType, PermissionMode, Risk

# --- action risk policy -----------------------------------------------------

# The server decides risk. A model may *suggest* a risk, it never lowers it.
RISK_BY_ACTION: dict[ActionType, Risk] = {
    ActionType.open_url: Risk.low,
    ActionType.search_files: Risk.low,
    ActionType.read_text_file: Risk.low,
    ActionType.open_app: Risk.medium,
    ActionType.create_text_file: Risk.medium,
}

_RISK_ORDER = {Risk.low: 0, Risk.medium: 1, Risk.high: 2}


def effective_risk(action: Action) -> Risk:
    """Server policy risk, or the model's if it claimed something higher."""
    policy = RISK_BY_ACTION[ActionType(action.type)]
    return action.risk if _RISK_ORDER[action.risk] > _RISK_ORDER[policy] else policy


def needs_confirmation(risk: Risk, mode: PermissionMode) -> bool:
    if mode is PermissionMode.manual:
        return True
    if mode is PermissionMode.ask:
        return risk is not Risk.low
    return risk is Risk.high  # auto


def plan_requires_confirmation(actions: list[Action], mode: PermissionMode) -> bool:
    return any(needs_confirmation(effective_risk(a), mode) for a in actions)


# --- URLs -------------------------------------------------------------------

DEFAULT_ALLOWED_URL_HOSTS: tuple[str, ...] = (
    "google.com",
    "youtube.com",
    "github.com",
    "wikipedia.org",
    "stackoverflow.com",
    "docs.python.org",
    "developer.mozilla.org",
    "localhost",
)


def _host_allowed(host: str, allowed: tuple[str, ...]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in allowed)


def validate_url(url: str, allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_URL_HOSTS) -> str:
    """Return a normalized https/http URL or raise ``PermissionError``."""
    raw = url.strip()
    if "://" not in raw:
        raw = "https://" + raw
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https"):
        raise PermissionError(f"Only http(s) URLs are allowed, got scheme '{parts.scheme or 'none'}'.")
    if not parts.hostname:
        raise PermissionError("URL has no host.")
    if parts.username or parts.password:
        raise PermissionError("URLs with embedded credentials are not allowed.")
    if not _host_allowed(parts.hostname, allowed_hosts):
        raise PermissionError(f"'{parts.hostname}' is not on the allowed sites list. Allowed: {', '.join(allowed_hosts)}.")
    return parts.geturl()


# --- apps -------------------------------------------------------------------

# app id -> argv per platform. No shell, no user-supplied arguments.
_APP_COMMANDS: dict[str, dict[str, list[str]]] = {
    "notepad": {"win32": ["notepad.exe"], "darwin": ["open", "-a", "TextEdit"], "linux": ["gedit"]},
    "calculator": {"win32": ["calc.exe"], "darwin": ["open", "-a", "Calculator"], "linux": ["gnome-calculator"]},
    "browser": {
        "win32": ["cmd", "/c", "start", "", "https://www.google.com"],
        "darwin": ["open", "https://www.google.com"],
        "linux": ["xdg-open", "https://www.google.com"],
    },
    "files": {"win32": ["explorer.exe"], "darwin": ["open", "-a", "Finder"], "linux": ["xdg-open", "."]},
    "terminal": {
        "win32": ["cmd", "/c", "start", "", "cmd.exe"],
        "darwin": ["open", "-a", "Terminal"],
        "linux": ["x-terminal-emulator"],
    },
    "vscode": {"win32": ["cmd", "/c", "start", "", "code"], "darwin": ["open", "-a", "Visual Studio Code"], "linux": ["code"]},
}

ALLOWED_APPS: tuple[str, ...] = tuple(sorted(_APP_COMMANDS))


def _platform_key() -> str:
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def resolve_app_command(app: str) -> list[str]:
    key = app.strip().lower()
    if key not in _APP_COMMANDS:
        raise PermissionError(f"'{app}' is not an allowed application. Allowed: {', '.join(ALLOWED_APPS)}.")
    return list(_APP_COMMANDS[key][_platform_key()])


# --- workspace paths --------------------------------------------------------

_BLOCKED_NAMES = {".env", ".git", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".pypirc", "credentials"}
_BLOCKED_SUFFIXES = (".pem", ".key", ".p12", ".pfx")


def resolve_workspace_path(workspace: Path, relative: str) -> Path:
    """Map a user/model supplied path onto the workspace, refusing escapes."""
    rel = relative.strip().replace("\\", "/")
    if not rel or rel in (".", "/"):
        raise PermissionError("A file path inside the workspace is required.")
    if rel.startswith("~") or "\0" in rel:
        raise PermissionError("Home-relative or NUL-containing paths are not allowed.")

    candidate = Path(rel)
    if candidate.is_absolute() or (len(rel) > 1 and rel[1] == ":"):
        raise PermissionError("Absolute paths are not allowed; use a path relative to the workspace.")

    root = workspace.resolve()
    target = (root / candidate).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise PermissionError("Path escapes the allowed workspace.") from exc

    for part in target.relative_to(root).parts:
        low = part.lower()
        if low in _BLOCKED_NAMES or low.endswith(_BLOCKED_SUFFIXES) or low.startswith(".git"):
            raise PermissionError(f"Access to '{part}' is blocked.")
    return target


def ensure_workspace(workspace: Path) -> Path:
    root = workspace.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    if not os.access(root, os.R_OK):
        raise PermissionError(f"Workspace '{root}' is not readable.")
    return root
