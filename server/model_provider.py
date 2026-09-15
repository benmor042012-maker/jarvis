"""Model provider adapter.

``ModelProvider`` is the only interface the planner talks to. ``MockProvider``
needs no network or key and understands a handful of natural commands.
``OpenAICompatibleProvider`` works with any server that speaks the
``/chat/completions`` protocol (OpenAI, Azure-style gateways, Ollama, LM
Studio, OpenRouter, ...). Both return a validated ``PlanResponse``; anything
else is an error, never executed.
"""

from __future__ import annotations

import json
import re
from typing import Protocol

import httpx
from pydantic import ValidationError

from .config import Settings
from .schemas import ConnectionStatus, ConnectionTestResult, PlanResponse

SYSTEM_PROMPT = """You are JARVIS, a calm, precise desktop assistant. You plan safe actions; you never run code.
Respond with ONE JSON object and nothing else, matching exactly:
{"message": string, "requires_confirmation": boolean, "actions": [ {"type": T, "payload": P, "risk": "low"|"medium"|"high"} ]}
Allowed action types and payloads:
- open_url            payload {"url": string}                       (only well-known sites; the server enforces an allowlist)
- open_app            payload {"app": "notepad"|"calculator"|"browser"|"files"|"terminal"|"vscode"}
- search_files        payload {"query": string, "max_results"?: int}  (searches only inside the user's workspace)
- read_text_file      payload {"path": string}                      (relative to the workspace)
- create_text_file    payload {"path": string, "content": string}   (relative to the workspace; never overwrites)
Rules: at most 5 actions. If the request is conversational, return an empty actions list and answer in "message".
If the request needs something outside these actions (deleting files, shell commands, sending messages, passwords), refuse in "message" with an empty actions list.
Keep "message" to one or two short sentences in the user's language."""


class ModelProvider(Protocol):
    name: str

    def plan(self, command: str) -> PlanResponse: ...

    def test_connection(self) -> ConnectionTestResult: ...


class ProviderError(RuntimeError):
    """A helpful, secret-free error message meant for the client."""


# --- mock -----------------------------------------------------------------------


class MockProvider:
    """Deterministic rule-based planner. Works offline, used until a key is set."""

    name = "mock"

    _URL_WORDS = {
        "youtube": "https://www.youtube.com",
        "google": "https://www.google.com",
        "github": "https://github.com",
        "wikipedia": "https://www.wikipedia.org",
        "stack overflow": "https://stackoverflow.com",
        "stackoverflow": "https://stackoverflow.com",
        "mdn": "https://developer.mozilla.org",
    }
    _APP_WORDS = {
        "notepad": "notepad",
        "text editor": "notepad",
        "editor": "notepad",
        "calculator": "calculator",
        "calc": "calculator",
        "browser": "browser",
        "chrome": "browser",
        "firefox": "browser",
        "edge": "browser",
        "files": "files",
        "file explorer": "files",
        "explorer": "files",
        "finder": "files",
        "terminal": "terminal",
        "command prompt": "terminal",
        "cmd": "terminal",
        "vscode": "vscode",
        "vs code": "vscode",
        "code editor": "vscode",
    }

    def plan(self, command: str) -> PlanResponse:  # noqa: C901 - small rule table
        text = command.strip()
        low = text.lower()

        m = re.match(r"^(?:please\s+)?(?:create|make|write|new)\s+(?:a\s+)?(?:text\s+)?(?:file|note)\s+(?:called\s+|named\s+)?([\w./-]+)(?:\s+(?:with|containing|saying|that says)\s+(.+))?$", low)
        if m:
            path = m.group(1)
            if not path.endswith((".txt", ".md")):
                path += ".txt"
            content = text[m.start(2) :].strip() if m.group(2) else ""
            return PlanResponse(
                message=f"I'll create {path} in your workspace.",
                actions=[{"type": "create_text_file", "payload": {"path": path, "content": content}, "risk": "medium"}],
            )

        m = re.match(r"^(?:please\s+)?(?:read|open|show|display)\s+(?:the\s+)?(?:file|note)\s+([\w./-]+)$", low)
        if m:
            return PlanResponse(
                message=f"Reading {m.group(1)}.",
                actions=[{"type": "read_text_file", "payload": {"path": m.group(1)}, "risk": "low"}],
            )

        m = re.match(r"^(?:please\s+)?(?:search|find|look)\s+(?:for\s+|files?\s+(?:named\s+|called\s+|for\s+)?)?(.+?)(?:\s+in\s+(?:my\s+)?(?:workspace|files))?$", low)
        if m and any(w in low for w in ("search", "find", "look for")):
            return PlanResponse(
                message=f"Searching your workspace for '{m.group(1)}'.",
                actions=[{"type": "search_files", "payload": {"query": m.group(1)}, "risk": "low"}],
            )

        m = re.match(r"^(?:please\s+)?(?:open|launch|start|go to|visit)\s+(.+)$", low)
        if m:
            target = m.group(1).strip().rstrip(".!")
            for word, url in self._URL_WORDS.items():
                if word in target:
                    return PlanResponse(
                        message=f"Opening {word.title()}.",
                        actions=[{"type": "open_url", "payload": {"url": url}, "risk": "low"}],
                    )
            if re.match(r"^(https?://)?[\w.-]+\.[a-z]{2,}(/\S*)?$", target):
                return PlanResponse(
                    message=f"Opening {target}.",
                    actions=[{"type": "open_url", "payload": {"url": target}, "risk": "low"}],
                )
            for word, app in sorted(self._APP_WORDS.items(), key=lambda kv: -len(kv[0])):
                if word in target:
                    return PlanResponse(
                        message=f"Launching {app}.",
                        actions=[{"type": "open_app", "payload": {"app": app}, "risk": "medium"}],
                    )
            return PlanResponse(message=f"I can't open '{target}'. Try a well-known site or one of: notepad, calculator, browser, files, terminal, vscode.")

        if any(w in low for w in ("delete", "remove", "rm ", "format", "password", "credential", "send message", "send email", "shutdown", "sudo")):
            return PlanResponse(message="That's outside my safe action set. I can open sites and apps, search, read and create text files in your workspace.")

        if any(w in low for w in ("hello", "hi", "hey", "who are you")):
            return PlanResponse(message="Online and ready. I'm running in mock mode; add an API key in Settings for a real model.")
        if "help" in low or "what can you do" in low:
            return PlanResponse(message="Try: 'open youtube', 'launch notepad', 'search for report', 'read file notes.txt', or 'create file todo.txt with buy milk'.")
        return PlanResponse(message="Mock mode: I understood that as conversation. Ask me to open a site or app, search, read or create a text file.")

    def test_connection(self) -> ConnectionTestResult:
        return ConnectionTestResult(status=ConnectionStatus.mock, detail="Mock provider active. No key needed.")


# --- OpenAI-compatible ----------------------------------------------------------


class OpenAICompatibleProvider:
    name = "openai-compatible"

    def __init__(self, settings: Settings, timeout: float = 45.0) -> None:
        self._settings = settings
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._settings.api_key}", "Content-Type": "application/json"}

    def _url(self, path: str) -> str:
        return self._settings.base_url.rstrip("/") + path

    @staticmethod
    def _safe_error(status: int, body: str) -> str:
        # Never echo the body verbatim: gateways sometimes reflect headers back.
        snippet = re.sub(r"(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+)", "***", body)[:200]
        return f"Provider returned HTTP {status}: {snippet}"

    def plan(self, command: str) -> PlanResponse:
        if not self._settings.has_api_key:
            raise ProviderError("No API key configured. Open Settings and add one, or use mock mode.")
        body = {
            "model": self._settings.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": command},
            ],
        }
        try:
            with httpx.Client(timeout=self._timeout) as client:
                r = client.post(self._url("/chat/completions"), headers=self._headers(), json=body)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Could not reach the model server: {exc.__class__.__name__}.") from exc
        if r.status_code == 401:
            raise ProviderError("The API key was rejected (401). Check it in Settings.")
        if r.status_code >= 400:
            raise ProviderError(self._safe_error(r.status_code, r.text))
        try:
            content = r.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("Provider response had no message content.") from exc
        return parse_plan(content)

    def test_connection(self) -> ConnectionTestResult:
        if not self._settings.has_api_key:
            return ConnectionTestResult(status=ConnectionStatus.missing_key, detail="No API key set.")
        try:
            with httpx.Client(timeout=15.0) as client:
                r = client.get(self._url("/models"), headers=self._headers())
        except httpx.HTTPError as exc:
            return ConnectionTestResult(status=ConnectionStatus.error, detail=f"Network error: {exc.__class__.__name__}.")
        if r.status_code == 401:
            return ConnectionTestResult(status=ConnectionStatus.invalid_key, detail="The provider rejected the API key.")
        if r.status_code >= 400:
            return ConnectionTestResult(status=ConnectionStatus.error, detail=self._safe_error(r.status_code, r.text))
        return ConnectionTestResult(status=ConnectionStatus.connected, detail=f"Connected to {self._settings.base_url} as {self._settings.model}.")


# --- helpers --------------------------------------------------------------------

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def parse_plan(content: str) -> PlanResponse:
    """Turn model text into a validated plan. Rejects anything that isn't the schema."""
    text = _FENCE.sub("", content.strip())
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ProviderError("The model did not return JSON.")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ProviderError("The model returned malformed JSON.") from exc
    if not isinstance(data, dict):
        raise ProviderError("The model returned JSON that is not an object.")
    data.pop("plan_id", None)
    data.pop("provider", None)
    try:
        return PlanResponse.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", ())) or "plan"
        raise ProviderError(f"The model proposed an invalid plan ({loc}: {first.get('msg', 'invalid')}).") from exc


def get_provider(settings: Settings) -> ModelProvider:
    """Provider used for planning: mock until a key is configured."""
    if settings.mock_mode:
        return MockProvider()
    return OpenAICompatibleProvider(settings)


def test_configured_provider(settings: Settings) -> ConnectionTestResult:
    """Connection test reflects what the user configured, so a missing key
    shows as *missing_key* rather than silently reporting mock."""
    if settings.force_mock:
        return MockProvider().test_connection()
    return OpenAICompatibleProvider(settings).test_connection()
