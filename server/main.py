"""JARVIS local backend.

Run:  uvicorn server.main:app --reload --port 8000
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .action_executor import ConfirmationRequired, JobRunner
from .action_planner import plan_command
from .config import APP_VERSION, Settings
from .logging_utils import get_logger, log_event
from .model_provider import ProviderError, test_configured_provider
from .schemas import (
    CommandRequest,
    ConnectionTestResult,
    ErrorResponse,
    ExecuteRequest,
    HealthResponse,
    JobView,
    PlanResponse,
    SettingsUpdate,
    SettingsView,
)

log = get_logger("jarvis.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.load()
    runner = JobRunner(settings)
    app = FastAPI(title="JARVIS", version=APP_VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.runner = runner

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(PermissionError)
    async def _perm(_: Request, exc: PermissionError) -> JSONResponse:
        status = 409 if isinstance(exc, ConfirmationRequired) else 403
        return JSONResponse(status_code=status, content=ErrorResponse(error="blocked" if status == 403 else "confirmation_required", detail=str(exc)).model_dump())

    @app.exception_handler(ProviderError)
    async def _prov(_: Request, exc: ProviderError) -> JSONResponse:
        return JSONResponse(status_code=502, content=ErrorResponse(error="provider_error", detail=str(exc)).model_dump())

    # --- api ---------------------------------------------------------------------

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(ok=True, version=APP_VERSION, mock_mode=settings.mock_mode)

    @app.post("/api/command", response_model=PlanResponse, responses={502: {"model": ErrorResponse}})
    def command(req: CommandRequest) -> PlanResponse:
        plan = plan_command(req.command, settings)
        log_event(log, "planned", provider=plan.provider, actions=[a.type for a in plan.actions], requires_confirmation=plan.requires_confirmation)
        return plan

    @app.post("/api/execute", response_model=JobView, status_code=202, responses={403: {"model": ErrorResponse}, 409: {"model": ErrorResponse}})
    def execute(req: ExecuteRequest) -> JobView:
        job = runner.submit(req.actions, req.confirmed)
        log_event(log, "job submitted", job_id=job.job_id, actions=[a.type for a in req.actions], confirmed=req.confirmed)
        return job.view()

    @app.get("/api/jobs/{job_id}", response_model=JobView, responses={404: {"model": ErrorResponse}})
    def job_status(job_id: str) -> JobView:
        job = runner.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown job.")
        return job.view()

    @app.post("/api/jobs/{job_id}/cancel", response_model=JobView, responses={404: {"model": ErrorResponse}})
    def job_cancel(job_id: str) -> JobView:
        job = runner.cancel(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown job.")
        return job.view()

    @app.get("/api/settings", response_model=SettingsView)
    def get_settings() -> SettingsView:
        return settings.view()

    @app.put("/api/settings", response_model=SettingsView)
    def put_settings(update: SettingsUpdate) -> SettingsView:
        if update.provider is not None:
            settings.provider = update.provider or settings.provider
        if update.model is not None:
            settings.model = update.model or settings.model
        if update.base_url is not None:
            settings.base_url = update.base_url or settings.base_url
        if update.workspace_dir is not None and update.workspace_dir.strip():
            candidate = Path(update.workspace_dir).expanduser()
            try:
                candidate.resolve().mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise HTTPException(status_code=400, detail=f"Workspace is not usable: {exc.__class__.__name__}") from exc
            settings.workspace_dir = str(candidate)
        if update.permission_mode is not None:
            settings.permission_mode = update.permission_mode
        if update.api_key is not None:
            settings.set_api_key(update.api_key)  # empty string clears
        settings.persist()
        log_event(log, "settings updated", fields=[k for k, v in update.model_dump().items() if v is not None])
        return settings.view()

    @app.post("/api/settings/test", response_model=ConnectionTestResult)
    def test_connection() -> ConnectionTestResult:
        return test_configured_provider(settings)

    # --- static client (after `npm run build`) -------------------------------------

    dist = Path(__file__).resolve().parent.parent / "client" / "dist"
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            candidate = dist / full_path
            if full_path and candidate.is_file() and candidate.resolve().is_relative_to(dist.resolve()):
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
