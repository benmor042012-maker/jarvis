// Speaking out loud through voice-extras/say.py, from Node.
//
// Nothing in JARVIS imports this file. It exists so that wiring the Edge voices
// in later is a one-line import rather than a change to the existing speech
// code, and so that the trade-off stays visible at the point of use: the text
// passed to `speak` is sent to Microsoft to be spoken. Everything else JARVIS
// says goes through client/src/lib/speech.ts, which never leaves the computer.
//
//   import { speak, serverUp } from "../voice-extras/say.mjs";
//   await speak("שלום, אני ג'רביס");
//
// If `say.py --serve` is running, the text goes to it and the first word comes
// back in well under a second. If it is not, Python is started for this one
// sentence, which costs about another second.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "say.py");
const WIN = process.platform === "win32";

function settings() {
  const file = join(HERE, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")).tts ?? {};
  } catch {
    return {};
  }
}

/** The venv interpreter the installer makes, or whatever python is on PATH. */
export function pythonPath() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const venv = join(home, ".jarvis", "voice-extras-venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python3");
  if (existsSync(venv)) return venv;
  return WIN ? "python" : "python3";
}

const port = () => Number(settings().serve_port) || 8771;

/** Is the warm voice server answering? */
export async function serverUp(timeoutMs = 400) {
  const stop = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/health`, { signal: stop });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Say something. Resolves once it has been spoken (or straight away with
 * `wait: false`). Never throws: it reports what happened, so a voice that is
 * not available cannot take the reply down with it.
 */
export async function speak(text, { voice, wait = true, timeoutMs = 180000 } = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) return { spoken: false, reason: null };

  if (await serverUp()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port()}/say`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean, voice, wait }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      // The server distinguishes "said it" from "could not say it", and so
      // does this: a reply that was never spoken must not come back as spoken.
      if (res.ok && body.spoken !== false) return { spoken: true, via: "server", ...body };
      return { spoken: false, via: "server", reason: body.detail || body.reason || body.error || `HTTP ${res.status}` };
    } catch (e) {
      return { spoken: false, via: "server", reason: String(e.message || e) };
    }
  }

  const args = [SCRIPT, ...(voice ? ["--voice", voice] : []), clean];
  return await new Promise((resolve) => {
    const child = spawn(pythonPath(), args, { cwd: HERE, windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += String(c).slice(0, 2000); });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ spoken: false, via: "python", reason: String(e.message || e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { spoken: true, via: "python" } : { spoken: false, via: "python", reason: err.trim() || `python exited ${code}` });
    });
  });
}

/** Stop mid-sentence. Only the warm server can do this. */
export async function stopSpeaking() {
  try {
    await fetch(`http://127.0.0.1:${port()}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}
