// Every child process JARVIS starts is tracked here so that cancellation and
// the emergency stop can kill the whole tree, not just the direct child.
const { spawn, execFile } = require("child_process");
const os = require("os");

const IS_WIN = os.platform() === "win32";
const children = new Set();

function track(child) {
  if (!child || !child.pid) return child;
  children.add(child);
  const drop = () => children.delete(child);
  child.once("exit", drop);
  child.once("error", drop);
  return child;
}

function killTree(child, signal = "SIGKILL") {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      // Children are started detached (own process group) so -pid reaches the tree.
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function killAll() {
  const n = children.size;
  for (const c of [...children]) killTree(c);
  children.clear();
  return n;
}

// Run an executable with an argv array (never a shell string). Resolves with
// { code, stdout, stderr, timedOut, cancelled }. Honors an AbortSignal.
function run(file, args = [], { timeoutMs = 30000, signal, env, cwd, input, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        detached: !IS_WIN,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    track(child);
    let stdout = "", stderr = "", timedOut = false, cancelled = false, done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, cancelled });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => { if (stdout.length < maxOutput) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { if (stderr.length < maxOutput) stderr += d.toString("utf8"); });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code) => finish(code));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Fire-and-forget launch (apps, browsers). Detached so quitting JARVIS does not
// close what it opened for the user.
function launch(file, args = []) {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

/**
 * A helper process JARVIS keeps around — today, the speech server that holds
 * the model in memory between sentences.
 *
 * Tracked like every other child, so quitting JARVIS takes it with it, and
 * attached rather than detached for the same reason: nothing of ours should
 * outlive the agent. Its output is dropped: it is a progress log, and the
 * useful part (whether it answers) is a question for the port, not the pipe.
 */
function spawnLong(file, args = [], { cwd, env } = {}) {
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    stdio: "ignore",
    windowsHide: true,
    detached: false,
  });
  child.on("error", () => {});
  track(child);
  return child;
}

module.exports = { run, launch, spawnLong, track, killTree, killAll, IS_WIN, count: () => children.size };
