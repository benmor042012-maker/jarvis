"""Executes validated actions, one at a time, with server-side confirmation
enforcement and a cancellable job model.

There is deliberately no generic "run command" here. Each action type has one
small function with a fixed, allowlisted behaviour.
"""

from __future__ import annotations

import os
import subprocess
import threading
import uuid
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .logging_utils import get_logger, log_event
from .permissions import (
    effective_risk,
    needs_confirmation,
    resolve_app_command,
    resolve_workspace_path,
    validate_url,
)
from .schemas import Action, ActionResult, ActionType, JobStatus, JobView

log = get_logger("jarvis.executor")

MAX_READ_BYTES = 200_000
SEARCH_SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".idea", ".vscode"}


class ConfirmationRequired(PermissionError):
    """Raised when an action needs confirmation the request did not carry."""


# --- individual actions ---------------------------------------------------------


def _open_url(action: Action, settings: Settings) -> ActionResult:
    url = validate_url(action.payload.url, settings.allowed_url_hosts)
    opened = webbrowser.open(url, new=2)
    return ActionResult(type=ActionType.open_url, ok=bool(opened), summary=f"Opened {url}" if opened else f"Could not open a browser for {url}", data={"url": url})


def _open_app(action: Action, settings: Settings) -> ActionResult:
    argv = resolve_app_command(action.payload.app)
    try:
        # No shell. argv is fixed by the allowlist; user input never reaches it.
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except (OSError, FileNotFoundError) as exc:
        return ActionResult(type=ActionType.open_app, ok=False, summary=f"Could not launch {action.payload.app}: {exc.__class__.__name__}", data={"app": action.payload.app})
    return ActionResult(type=ActionType.open_app, ok=True, summary=f"Launched {action.payload.app}", data={"app": action.payload.app})


def _search_files(action: Action, settings: Settings) -> ActionResult:
    root = settings.workspace
    query = action.payload.query.lower()
    limit = action.payload.max_results
    hits: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SEARCH_SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if query in name.lower():
                hits.append(str(Path(dirpath, name).relative_to(root)))
                if len(hits) >= limit:
                    break
        if len(hits) >= limit:
            break
    return ActionResult(
        type=ActionType.search_files,
        ok=True,
        summary=f"Found {len(hits)} file(s) matching '{action.payload.query}'",
        data={"matches": hits, "workspace": str(root)},
    )


def _read_text_file(action: Action, settings: Settings) -> ActionResult:
    target = resolve_workspace_path(settings.workspace, action.payload.path)
    if not target.is_file():
        return ActionResult(type=ActionType.read_text_file, ok=False, summary=f"No file named {action.payload.path} in the workspace", data={})
    size = target.stat().st_size
    with target.open("rb") as fh:
        raw = fh.read(MAX_READ_BYTES)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return ActionResult(type=ActionType.read_text_file, ok=False, summary=f"{action.payload.path} is not a text file", data={})
    return ActionResult(
        type=ActionType.read_text_file,
        ok=True,
        summary=f"Read {action.payload.path} ({size} bytes{', truncated' if size > MAX_READ_BYTES else ''})",
        data={"path": action.payload.path, "content": text, "truncated": size > MAX_READ_BYTES},
    )


def _create_text_file(action: Action, settings: Settings) -> ActionResult:
    target = resolve_workspace_path(settings.workspace, action.payload.path)
    if target.exists():
        return ActionResult(type=ActionType.create_text_file, ok=False, summary=f"{action.payload.path} already exists; I don't overwrite files", data={})
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as fh:
        fh.write(action.payload.content)
    return ActionResult(type=ActionType.create_text_file, ok=True, summary=f"Created {action.payload.path}", data={"path": action.payload.path, "bytes": len(action.payload.content.encode("utf-8"))})


_HANDLERS = {
    "open_url": _open_url,
    "open_app": _open_app,
    "search_files": _search_files,
    "read_text_file": _read_text_file,
    "create_text_file": _create_text_file,
}


def execute_action(action: Action, settings: Settings, confirmed: bool) -> ActionResult:
    """Run one action. Enforces confirmation here, regardless of what the UI did."""
    risk = effective_risk(action)
    if needs_confirmation(risk, settings.permission_mode) and not confirmed:
        raise ConfirmationRequired(f"{action.type} is {risk.value} risk and needs your confirmation first.")
    handler = _HANDLERS.get(action.type)
    if handler is None:  # unreachable thanks to the schema, kept as belt and braces
        raise PermissionError(f"Action type '{action.type}' is not allowed.")
    return handler(action, settings)


# --- jobs (cancellable, sequential) ---------------------------------------------


@dataclass
class Job:
    job_id: str
    actions: list[Action]
    confirmed: bool
    status: JobStatus = JobStatus.queued
    results: list[ActionResult] = field(default_factory=list)
    error: str | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def view(self) -> JobView:
        return JobView(job_id=self.job_id, status=self.status, results=list(self.results), error=self.error, total=len(self.actions), completed=len(self.results))


class JobRunner:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def precheck(self, actions: list[Action], confirmed: bool) -> None:
        """Fail fast before anything runs if any action is unconfirmed or disallowed."""
        for action in actions:
            risk = effective_risk(action)
            if needs_confirmation(risk, self._settings.permission_mode) and not confirmed:
                raise ConfirmationRequired(f"{action.type} is {risk.value} risk and needs your confirmation first.")
            if action.type == "open_url":
                validate_url(action.payload.url, self._settings.allowed_url_hosts)
            elif action.type == "open_app":
                resolve_app_command(action.payload.app)
            elif action.type in ("read_text_file", "create_text_file"):
                resolve_workspace_path(self._settings.workspace, action.payload.path)

    def submit(self, actions: list[Action], confirmed: bool) -> Job:
        self.precheck(actions, confirmed)
        job = Job(job_id=uuid.uuid4().hex, actions=list(actions), confirmed=confirmed)
        with self._lock:
            self._jobs[job.job_id] = job
            if len(self._jobs) > 200:
                for old in list(self._jobs)[:-100]:
                    if self._jobs[old].status not in (JobStatus.queued, JobStatus.running):
                        del self._jobs[old]
        threading.Thread(target=self._run, args=(job,), daemon=True, name=f"job-{job.job_id[:8]}").start()
        return job

    def run_sync(self, actions: list[Action], confirmed: bool) -> Job:
        """Same as submit but blocking; used by tests."""
        self.precheck(actions, confirmed)
        job = Job(job_id=uuid.uuid4().hex, actions=list(actions), confirmed=confirmed)
        with self._lock:
            self._jobs[job.job_id] = job
        self._run(job)
        return job

    def _run(self, job: Job) -> None:
        job.status = JobStatus.running
        for action in job.actions:
            if job.cancel_event.is_set():
                job.status = JobStatus.cancelled
                log_event(log, "job cancelled", job_id=job.job_id, completed=len(job.results))
                return
            try:
                result = execute_action(action, self._settings, job.confirmed)
            except PermissionError as exc:
                job.status = JobStatus.failed
                job.error = str(exc)
                log_event(log, "action blocked", job_id=job.job_id, action=action.type, reason=str(exc))
                return
            except Exception as exc:  # noqa: BLE001 - we want a readable failure, not a crash
                job.status = JobStatus.failed
                job.error = f"{action.type} failed: {exc.__class__.__name__}"
                log.exception("action crashed", extra={"extra_fields": {"job_id": job.job_id, "action": action.type}})
                return
            job.results.append(result)
            log_event(log, "action done", job_id=job.job_id, action=action.type, ok=result.ok, summary=result.summary)
        job.status = JobStatus.done

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None:
            return None
        job.cancel_event.set()
        if job.status == JobStatus.queued:
            job.status = JobStatus.cancelled
        return job
