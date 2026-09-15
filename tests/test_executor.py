from __future__ import annotations

import threading
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from server import action_executor
from server.action_executor import ConfirmationRequired, JobRunner, execute_action
from server.config import Settings
from server.schemas import Action, JobStatus, PermissionMode

_action = TypeAdapter(Action)


def _a(t: str, payload: dict, risk: str = "low"):
    return _action.validate_python({"type": t, "payload": payload, "risk": risk})


# --- confirmation is enforced server-side -------------------------------------------


def test_medium_risk_without_confirmation_is_refused(settings: Settings) -> None:
    with pytest.raises(ConfirmationRequired):
        execute_action(_a("create_text_file", {"path": "a.txt", "content": "x"}), settings, confirmed=False)
    assert not (Path(settings.workspace_dir) / "a.txt").exists()


def test_manual_mode_refuses_even_low_risk(settings: Settings) -> None:
    settings.permission_mode = PermissionMode.manual
    with pytest.raises(ConfirmationRequired):
        execute_action(_a("search_files", {"query": "x"}), settings, confirmed=False)


def test_runner_prechecks_whole_batch_before_running_anything(settings: Settings) -> None:
    runner = JobRunner(settings)
    with pytest.raises(ConfirmationRequired):
        runner.run_sync([_a("search_files", {"query": "x"}), _a("create_text_file", {"path": "b.txt"})], confirmed=False)
    assert not (Path(settings.workspace_dir) / "b.txt").exists()


# --- file actions -------------------------------------------------------------------------


def test_create_then_read_then_search(settings: Settings) -> None:
    runner = JobRunner(settings)
    job = runner.run_sync(
        [
            _a("create_text_file", {"path": "notes/todo.txt", "content": "buy milk"}),
            _a("read_text_file", {"path": "notes/todo.txt"}),
            _a("search_files", {"query": "todo"}),
        ],
        confirmed=True,
    )
    assert job.status is JobStatus.done
    assert [r.ok for r in job.results] == [True, True, True]
    assert job.results[1].data["content"] == "buy milk"
    assert job.results[2].data["matches"] == ["notes/todo.txt"]


def test_create_never_overwrites(settings: Settings) -> None:
    p = Path(settings.workspace_dir) / "keep.txt"
    p.write_text("original")
    res = execute_action(_a("create_text_file", {"path": "keep.txt", "content": "new"}), settings, confirmed=True)
    assert res.ok is False and p.read_text() == "original"


def test_read_missing_and_binary_files(settings: Settings) -> None:
    assert execute_action(_a("read_text_file", {"path": "nope.txt"}), settings, confirmed=True).ok is False
    (Path(settings.workspace_dir) / "bin.dat").write_bytes(b"\xff\xfe\x00\x01")
    assert execute_action(_a("read_text_file", {"path": "bin.dat"}), settings, confirmed=True).ok is False


def test_traversal_is_blocked_at_execution(settings: Settings) -> None:
    with pytest.raises(PermissionError):
        execute_action(_a("read_text_file", {"path": "../../etc/hosts"}), settings, confirmed=True)


def test_search_skips_hidden_and_dependency_dirs(settings: Settings) -> None:
    ws = Path(settings.workspace_dir)
    (ws / "node_modules").mkdir()
    (ws / "node_modules" / "secret-report.txt").write_text("x")
    (ws / ".hidden").mkdir()
    (ws / ".hidden" / "report.txt").write_text("x")
    (ws / "report.txt").write_text("x")
    res = execute_action(_a("search_files", {"query": "report"}), settings, confirmed=True)
    assert res.data["matches"] == ["report.txt"]


# --- external actions are stubbed, never really launched in tests ------------------------


def test_open_url_uses_browser_with_validated_url(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(action_executor.webbrowser, "open", lambda url, new=0: opened.append(url) or True)
    res = execute_action(_a("open_url", {"url": "github.com"}), settings, confirmed=False)
    assert res.ok and opened == ["https://github.com"]


def test_open_url_blocked_host_never_reaches_browser(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(action_executor.webbrowser, "open", lambda *_a, **_k: pytest.fail("browser must not open"))
    with pytest.raises(PermissionError):
        execute_action(_a("open_url", {"url": "https://evil.example"}), settings, confirmed=True)


def test_open_app_spawns_allowlisted_argv_without_shell(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []

    class _P:
        def __init__(self, argv, **kw):
            calls.append((argv, kw))

    monkeypatch.setattr(action_executor.subprocess, "Popen", _P)
    res = execute_action(_a("open_app", {"app": "notepad"}), settings, confirmed=True)
    assert res.ok and calls and isinstance(calls[0][0], list) and "shell" not in calls[0][1]


# --- cancellation -------------------------------------------------------------------------


def test_cancel_stops_before_next_action(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    started = threading.Event()
    release = threading.Event()

    def slow_search(action, s):
        started.set()
        release.wait(5)
        return action_executor.ActionResult(type="search_files", ok=True, summary="slow")

    monkeypatch.setitem(action_executor._HANDLERS, "search_files", slow_search)
    runner = JobRunner(settings)
    job = runner.submit([_a("search_files", {"query": "a"}), _a("search_files", {"query": "b"})], confirmed=True)
    assert started.wait(5)
    runner.cancel(job.job_id)
    release.set()
    for _ in range(100):
        if job.status in (JobStatus.cancelled, JobStatus.done):
            break
        threading.Event().wait(0.02)
    assert job.status is JobStatus.cancelled
    assert len(job.results) == 1
