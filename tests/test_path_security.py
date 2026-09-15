from __future__ import annotations

from pathlib import Path

import pytest

from server.permissions import resolve_workspace_path


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "a.txt").write_text("hi")
    return root


def test_relative_paths_stay_inside(ws: Path) -> None:
    assert resolve_workspace_path(ws, "sub/a.txt") == (ws / "sub" / "a.txt").resolve()
    assert resolve_workspace_path(ws, "sub\\a.txt") == (ws / "sub" / "a.txt").resolve()
    assert resolve_workspace_path(ws, "./new/file.txt") == (ws / "new" / "file.txt").resolve()


@pytest.mark.parametrize(
    "bad",
    [
        "../secret.txt",
        "sub/../../secret.txt",
        "/etc/passwd",
        "C:\\Windows\\system.ini",
        "~/.ssh/id_rsa",
        "..",
        "",
        ".",
        ".env",
        "sub/.env",
        ".git/config",
        "keys/server.pem",
        "id_rsa",
        "a\0b",
    ],
)
def test_escapes_and_secrets_are_blocked(ws: Path, bad: str) -> None:
    with pytest.raises(PermissionError):
        resolve_workspace_path(ws, bad)


def test_symlink_escape_is_blocked(ws: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("nope")
    link = ws / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported here")
    with pytest.raises(PermissionError):
        resolve_workspace_path(ws, "link/secret.txt")
