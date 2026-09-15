"""Runtime settings.

Secrets (the API key) live only in the process: loaded from the environment
or set via the settings API. They are never written to disk by this module
and never returned to a client. Non-secret settings persist to a small JSON
file so they survive restarts.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .permissions import ALLOWED_APPS, DEFAULT_ALLOWED_URL_HOSTS, ensure_workspace
from .schemas import PermissionMode, SettingsView

APP_VERSION = "1.0.0"
_ROOT = Path(__file__).resolve().parent.parent
_DATA_DIR = _ROOT / "server" / "data"
_SETTINGS_FILE = _DATA_DIR / "settings.json"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Settings:
    provider: str = "openai-compatible"
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    workspace_dir: str = str(_ROOT / "workspace")
    permission_mode: PermissionMode = PermissionMode.ask
    allowed_url_hosts: tuple[str, ...] = DEFAULT_ALLOWED_URL_HOSTS
    force_mock: bool = False
    _api_key: str = field(default="", repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # --- secrets -------------------------------------------------------------
    @property
    def api_key(self) -> str:
        return self._api_key

    def set_api_key(self, value: str | None) -> None:
        with self._lock:
            self._api_key = (value or "").strip()

    @property
    def has_api_key(self) -> bool:
        return bool(self._api_key)

    @property
    def api_key_hint(self) -> str:
        """Masked hint safe to show: '••••abcd' or ''. Never the key."""
        if not self._api_key:
            return ""
        return "••••" + self._api_key[-4:] if len(self._api_key) >= 8 else "••••"

    @property
    def mock_mode(self) -> bool:
        return self.force_mock or not self.has_api_key

    # --- workspace -------------------------------------------------------------
    @property
    def workspace(self) -> Path:
        return ensure_workspace(Path(self.workspace_dir))

    # --- views -----------------------------------------------------------------
    def view(self) -> SettingsView:
        return SettingsView(
            provider=self.provider,
            model=self.model,
            base_url=self.base_url,
            workspace_dir=str(Path(self.workspace_dir).expanduser()),
            permission_mode=self.permission_mode,
            has_api_key=self.has_api_key,
            api_key_hint=self.api_key_hint,
            mock_mode=self.mock_mode,
            allowed_url_hosts=list(self.allowed_url_hosts),
            allowed_apps=list(ALLOWED_APPS),
        )

    # --- persistence (non-secret only) -----------------------------------------
    def persist(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "workspace_dir": self.workspace_dir,
            "permission_mode": self.permission_mode.value,
        }
        _SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    @classmethod
    def load(cls) -> Settings:
        s = cls()
        # env first
        s.provider = _env("JARVIS_PROVIDER", s.provider)
        s.model = _env("JARVIS_MODEL", s.model)
        s.base_url = _env("JARVIS_BASE_URL", s.base_url)
        s.workspace_dir = _env("JARVIS_WORKSPACE_DIR", s.workspace_dir)
        mode = _env("JARVIS_PERMISSION_MODE", "")
        if mode in {m.value for m in PermissionMode}:
            s.permission_mode = PermissionMode(mode)
        hosts = _env("JARVIS_ALLOWED_URL_HOSTS", "")
        if hosts:
            s.allowed_url_hosts = tuple(h.strip().lower() for h in hosts.split(",") if h.strip())
        s.force_mock = _env("JARVIS_MOCK", "").lower() in {"1", "true", "yes"}
        s.set_api_key(_env("JARVIS_API_KEY") or _env("OPENAI_API_KEY"))
        # persisted overrides (non-secret) win over env defaults when present
        try:
            if _SETTINGS_FILE.exists():
                data = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
                for key in ("provider", "model", "base_url", "workspace_dir"):
                    if isinstance(data.get(key), str) and data[key].strip():
                        setattr(s, key, data[key].strip())
                if data.get("permission_mode") in {m.value for m in PermissionMode}:
                    s.permission_mode = PermissionMode(data["permission_mode"])
        except (OSError, ValueError):
            pass
        return s
