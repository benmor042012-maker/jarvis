"""Talking to the JARVIS agent from a separate process.

Nothing in this file imports anything outside the Python standard library, so
it works before `pip install` has run and can be used by the installer itself
to explain what is missing.

The agent it talks to is the ordinary local one: an HTTP server bound to
127.0.0.1 (port 8765 unless config.json says otherwise). Two ways in:

  * `/api/health` — unauthenticated, read-only, used only to answer "is JARVIS
    running right now".
  * `/api/voice/wake` — the same signed request the JARVIS window itself sends
    when its own detector hears the phrase. It is signed with the owner
    device's secret, so it only works when that secret is readable as plain
    text. On Windows the secret is encrypted with DPAPI and can only be read
    from inside the app, so this path is best effort by design.

When the signed path is not available — which is the normal case on Windows —
waking falls back to launching JARVIS. Electron's single-instance lock turns a
second launch into "show the window" on the instance already running, so the
same command both starts it when it is closed and brings it up from the tray
when it is minimised.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import logging.handlers
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

IS_WINDOWS = platform.system() == "Windows"

# Keep in step with desktop/src/core/paths.js and desktop/src/core/config.js.
DEFAULT_PORT = 8765
PROTOCOL_VERSION = 1

DEFAULTS: dict[str, Any] = {
    "wake": {
        # openWakeWord ships a free pre-trained model for the phrase
        # "hey jarvis". "jarvis" on its own has no pre-trained model; point
        # this at your own .onnx/.tflite file if you train one.
        "model": "hey_jarvis",
        "threshold": 0.5,
        # Ignore anything heard within this many seconds of the last wake, so
        # one spoken phrase never fires twice.
        "cooldown_seconds": 3.0,
        # How many consecutive frames must be over the threshold. 1 answers
        # fastest; 2 trades ~80 ms for noticeably fewer false wakes.
        "frames_to_trigger": 1,
        "inference_framework": "onnx",
        "vad_threshold": 0.0,
        "input_device": None,
        "quiet_hours": {"enabled": False, "start": "23:00", "end": "07:00"},
        # Run this when the phrase is heard. Empty list = use the launcher
        # below, which is what you want unless you have something else in mind.
        "command": [],
        # Extra local URL to POST to, for anyone wiring this into something
        # else. {"url": "http://127.0.0.1:8765/api/health", "body": {...}}
        "post": None,
        "launch": True,
        "notify": True,
    },
    "tts": {
        "voice": "he-IL-AvriNeural",
        "fallback_voice": "en-US-BrianNeural",
        "rate": "+0%",
        "volume": "+0%",
        "pitch": "+0Hz",
        "serve_port": 8771,
        # Start speaking once this many characters are buffered, even if no
        # sentence has ended yet. Keeps the first word under a second when a
        # model is still writing.
        "first_chunk_chars": 60,
    },
    "agent": {
        "host": "127.0.0.1",
        "port": None,  # None = read it from ~/.jarvis/config.json
        "timeout_seconds": 4.0,
    },
    "log_level": "INFO",
}


# --- config -------------------------------------------------------------------


def number(value: Any, default: float) -> float:
    """A configured number, falling back only when there isn't one.

    `float(value or default)` looks like it does this and does not: a
    deliberate 0 is falsy, so "cooldown_seconds": 0 quietly becomes 3 and the
    setting appears to do nothing.
    """
    if isinstance(value, bool) or value is None:
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def jarvis_home() -> Path:
    return Path(os.environ.get("JARVIS_HOME") or (Path.home() / ".jarvis"))


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def config_path(explicit: str | os.PathLike[str] | None = None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("JARVIS_EXTRAS_CONFIG")
    if env:
        return Path(env)
    return HERE / "config.json"


def load_config(explicit: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Defaults, with config.json layered on top when it exists.

    A broken config.json is reported and then ignored: a typo in a settings
    file must not be the reason the computer stops answering to its name.
    """
    path = config_path(explicit)
    if not path.exists():
        return json.loads(json.dumps(DEFAULTS))
    try:
        user = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(user, dict):
            raise ValueError("the top level must be an object")
        return _deep_merge(DEFAULTS, user)
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        logging.getLogger("jarvis").warning("Ignoring %s: %s", path, exc)
        return json.loads(json.dumps(DEFAULTS))


# --- logging ------------------------------------------------------------------


def setup_logging(name: str, level: str = "INFO", to_file: bool = True) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(fmt)
    logger.addHandler(stream)
    if to_file:
        try:
            logs = jarvis_home() / "logs"
            logs.mkdir(parents=True, exist_ok=True)
            rotating = logging.handlers.RotatingFileHandler(
                logs / f"{name}.log", maxBytes=512 * 1024, backupCount=2, encoding="utf-8"
            )
            rotating.setFormatter(fmt)
            logger.addHandler(rotating)
        except OSError:
            pass  # stderr alone is enough; never fail to start over a log file
    return logger


# --- the signed command protocol (desktop/src/core/protocol.js) ----------------


def canonical(value: Any) -> str:
    """Deterministic JSON, byte for byte what util.js `canonical` produces."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return "null"  # JSON.stringify(NaN) === "null"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)  # shortest round-trip, same as JavaScript's
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(k for k, v in value.items() if v is not ...)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(f"cannot canonicalise {type(value).__name__}")


def params_hash(params: Any) -> str:
    return hashlib.sha256(canonical({} if params is None else params).encode("utf-8")).hexdigest()


def sign_envelope(params: dict[str, Any], device_id: str, secret: str, path: str, method: str = "POST", ttl_ms: int = 60_000) -> dict[str, Any]:
    now = int(time.time() * 1000)
    env = {
        "v": PROTOCOL_VERSION,
        "id": str(uuid.uuid4()),
        "device_id": device_id,
        "ts": now,
        "expires": now + ttl_ms,
        "nonce": uuid.uuid4().hex,
        "params": params,
    }
    digest = params_hash(params)
    signing_string = "\n".join(
        [
            str(env["v"]),
            env["id"],
            env["device_id"],
            str(env["ts"]),
            str(env["expires"]),
            env["nonce"],
            method.upper(),
            path,
            digest,
        ]
    )
    env["params_hash"] = digest
    env["signature"] = hmac.new(secret.encode("utf-8"), signing_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return env


def owner_device() -> tuple[str, str] | None:
    """The owner device id and secret, when the secret is stored as plain text.

    Returns None when there is no owner device, or when its secret is
    encrypted (`secret_enc`) — which is what Windows does, and is a good thing.
    """
    file = jarvis_home() / "devices.json"
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    devices = data.get("devices") if isinstance(data, dict) else data
    if not isinstance(devices, list):
        return None
    for dev in devices:
        if not isinstance(dev, dict):
            continue
        if dev.get("role") != "owner" or dev.get("revoked"):
            continue
        secret = dev.get("secret")
        if isinstance(secret, str) and secret and isinstance(dev.get("id"), str):
            return dev["id"], secret
    return None


# --- reaching the agent -------------------------------------------------------


def agent_port(cfg: dict[str, Any] | None = None) -> int:
    configured = ((cfg or {}).get("agent") or {}).get("port")
    if isinstance(configured, int) and configured > 0:
        return configured
    try:
        data = json.loads((jarvis_home() / "config.json").read_text(encoding="utf-8"))
        port = int(((data.get("server") or {}).get("port")) or 0)
        if port > 0:
            return port
    except (OSError, ValueError, TypeError):
        pass
    return DEFAULT_PORT


def agent_base(cfg: dict[str, Any] | None = None) -> str:
    host = ((cfg or {}).get("agent") or {}).get("host") or "127.0.0.1"
    return f"http://{host}:{agent_port(cfg)}"


def _timeout(cfg: dict[str, Any] | None) -> float:
    try:
        return float(((cfg or {}).get("agent") or {}).get("timeout_seconds") or 4.0)
    except (TypeError, ValueError):
        return 4.0


def health(cfg: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """What /api/health says, or None when JARVIS is not answering."""
    url = f"{agent_base(cfg)}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=_timeout(cfg)) as resp:  # noqa: S310 - fixed loopback URL
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def post_json(url: str, body: dict[str, Any], timeout: float = 4.0) -> tuple[int, dict[str, Any] | None]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - caller supplies a loopback URL
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, None
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except (ValueError, OSError):
            return exc.code, None
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        return 0, {"error": "unreachable", "detail": str(exc)}


def signed_wake(cfg: dict[str, Any] | None = None) -> tuple[bool, str]:
    """Ask a running JARVIS to start listening, the way its own window does.

    Returns (worked, why). `worked` is False whenever the owner secret is not
    readable here — that is expected on Windows and is not an error.
    """
    owner = owner_device()
    if not owner:
        return False, "the owner secret is not readable from outside the app (this is normal on Windows)"
    device_id, secret = owner
    path = "/api/voice/wake"
    envelope = sign_envelope({"ms": 900, "distance": None}, device_id, secret, path)
    status, body = post_json(agent_base(cfg) + path, envelope, _timeout(cfg))
    if status == 200:
        # The signature was accepted. The agent may still decide not to listen
        # — muted, paused, quiet hours, no microphone permission yet — and it
        # says which, so the log says it too rather than claiming a wake.
        action = ((body or {}).get("action")) or "woke"
        why = ((body or {}).get("detail")) or ((body or {}).get("reason")) or ""
        return action == "woke", f"the agent answered {action}{': ' + str(why) if why else ''}"
    detail = ((body or {}).get("detail")) or ((body or {}).get("error")) or f"HTTP {status}"
    return False, str(detail)


# --- launching / focusing -----------------------------------------------------


def launch_command() -> list[str] | None:
    """How to start JARVIS, or bring its window up when it is already running.

    Electron holds a single-instance lock, so running this a second time does
    not start a second JARVIS: the one already running shows its window.
    """
    installed = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "JARVIS" / "JARVIS.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "JARVIS" / "JARVIS.exe",
    ]
    for exe in installed:
        try:
            if exe.is_file():
                return [str(exe)]
        except OSError:
            continue
    bat = REPO / "START-JARVIS.bat"
    if IS_WINDOWS and bat.is_file():
        return ["cmd", "/c", "start", "", str(bat)]
    if (REPO / "package.json").is_file():
        npm = "npm.cmd" if IS_WINDOWS else "npm"
        return [npm, "start", "--prefix", str(REPO)]
    return None


def run_detached(command: Iterable[str], logger: logging.Logger | None = None) -> bool:
    cmd = list(command)
    if not cmd:
        return False
    kwargs: dict[str, Any] = {"cwd": str(REPO), "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if IS_WINDOWS:
        kwargs["creationflags"] = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(cmd, **kwargs)  # noqa: S603 - the command comes from this machine's own config
        return True
    except (OSError, ValueError) as exc:
        if logger:
            logger.error("Could not run %s: %s", cmd, exc)
        return False
