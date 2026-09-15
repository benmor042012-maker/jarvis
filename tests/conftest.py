from __future__ import annotations

from pathlib import Path

import pytest

from server import config
from server.config import Settings
from server.schemas import PermissionMode


@pytest.fixture(autouse=True)
def _isolated_settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Never let a test touch the developer's real server/data/settings.json."""
    monkeypatch.setattr(config, "_DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "_SETTINGS_FILE", tmp_path / "data" / "settings.json")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    s = Settings()
    s.workspace_dir = str(tmp_path / "ws")
    s.permission_mode = PermissionMode.ask
    s.force_mock = True
    s.set_api_key("")
    (tmp_path / "ws").mkdir()
    return s
