// Launch/close approved applications and open URLs/files with the default
// handler. Always argv, never a shell string.
const os = require("os");
const fs = require("fs");
const path = require("path");
const procs = require("../procs");
const { resolveApproved } = require("./files");

const PLATFORM = os.platform();

// Built-in allowlist: app id -> argv per platform (constants only).
const BUILTIN = {
  notepad: { title: "Notepad", win32: ["notepad.exe"], darwin: ["open", "-a", "TextEdit"], linux: ["gedit"] },
  calculator: { title: "Calculator", win32: ["calc.exe"], darwin: ["open", "-a", "Calculator"], linux: ["gnome-calculator"] },
  explorer: { title: "File Explorer", win32: ["explorer.exe"], darwin: ["open", "-a", "Finder"], linux: ["xdg-open", "."] },
  paint: { title: "Paint", win32: ["mspaint.exe"], darwin: null, linux: null },
  wordpad: { title: "WordPad", win32: ["write.exe"], darwin: null, linux: null },
  terminal: { title: "Terminal", win32: ["cmd.exe", "/c", "start", "", "cmd.exe"], darwin: ["open", "-a", "Terminal"], linux: ["x-terminal-emulator"] },
  browser: { title: "Default browser", win32: ["rundll32.exe", "url.dll,FileProtocolHandler", "about:blank"], darwin: ["open", "about:blank"], linux: ["xdg-open", "about:blank"] },
  vscode: { title: "Visual Studio Code", win32: ["cmd.exe", "/c", "start", "", "code"], darwin: ["open", "-a", "Visual Studio Code"], linux: ["code"] },
  settings: { title: "Windows Settings", win32: ["cmd.exe", "/c", "start", "", "ms-settings:"], darwin: null, linux: null },
  snipping: { title: "Snipping Tool", win32: ["cmd.exe", "/c", "start", "", "ms-screenclip:"], darwin: null, linux: null },
};

const PROCESS_NAMES = { notepad: "notepad.exe", calculator: "CalculatorApp.exe", explorer: "explorer.exe", paint: "mspaint.exe", wordpad: "wordpad.exe", vscode: "Code.exe" };

function catalog(cfg) {
  const out = [];
  for (const [id, def] of Object.entries(BUILTIN)) {
    out.push({ id, title: def.title, builtin: true, available: !!def[PLATFORM] });
  }
  for (const app of cfg.extraApps || []) {
    if (app && app.id && app.path) out.push({ id: String(app.id).toLowerCase(), title: app.title || app.id, builtin: false, available: fs.existsSync(app.path), path: app.path });
  }
  return out;
}

function resolveApp(cfg, id) {
  const key = String(id || "").trim().toLowerCase();
  if (BUILTIN[key]) {
    const argv = BUILTIN[key][PLATFORM];
    if (!argv) throw new Error(`${BUILTIN[key].title} is not available on this operating system.`);
    return { title: BUILTIN[key].title, argv: [...argv] };
  }
  const extra = (cfg.extraApps || []).find((a) => a && String(a.id).toLowerCase() === key);
  if (extra) {
    if (!path.isAbsolute(extra.path) || !fs.existsSync(extra.path)) throw new Error(`The path configured for ${key} does not exist.`);
    return { title: extra.title || key, argv: [extra.path] };
  }
  const ids = catalog(cfg).filter((a) => a.available).map((a) => a.id);
  throw new Error(`'${id}' is not an approved application. Approved: ${ids.join(", ")}. Add more in Settings.`);
}

const open_app = {
  name: "open_app", title: "Open application", category: "apps", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Open an approved application by id (notepad, calculator, explorer, paint, terminal, browser, vscode, or a user-added app).",
  schema: { type: "object", properties: { app: { type: "string", minLength: 1, maxLength: 64 } }, required: ["app"] },
  describe: (p) => `Open ${p.app}`,
  async run({ app }, { cfg }) {
    const { title, argv } = resolveApp(cfg, app);
    const pid = procs.launch(argv[0], argv.slice(1));
    return { ok: true, summary: `Opened ${title}`, data: { app, pid } };
  },
};

const close_app = {
  name: "close_app", title: "Close application", category: "apps", risk: "medium", reversible: false, timeoutMs: 10000,
  description: "Close an approved application (asks first: unsaved work may be lost). Windows only.",
  platforms: ["win32"],
  schema: { type: "object", properties: { app: { type: "string", minLength: 1, maxLength: 64 } }, required: ["app"] },
  describe: (p) => `Close ${p.app}`,
  async run({ app }, { cfg, signal }) {
    const key = String(app).toLowerCase();
    let image = PROCESS_NAMES[key];
    const extra = (cfg.extraApps || []).find((a) => a && String(a.id).toLowerCase() === key);
    if (!image && extra) image = path.basename(extra.path);
    if (!image) throw new Error(`I don't know how to close '${app}'.`);
    const res = await procs.run("taskkill.exe", ["/IM", image], { timeoutMs: 8000, signal });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || "taskkill failed").trim().slice(0, 300));
    return { ok: true, summary: `Asked ${image} to close`, data: { app, image } };
  },
};

function hostAllowed(hostname, allowed) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (allowed || []).some((h) => h === "*" || host === h || host.endsWith("." + h));
}

function validateUrl(url, cfg) {
  let raw = String(url || "").trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = "https://" + raw;
  let u;
  try { u = new URL(raw); } catch { throw new Error("That is not a valid URL."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) links can be opened.");
  if (u.username || u.password) throw new Error("Links with embedded credentials are refused.");
  if (!hostAllowed(u.hostname, cfg.allowedUrlHosts)) throw new Error(`${u.hostname} is not on the allowed sites list (Settings → allowed sites).`);
  return u.toString();
}

function openWithDefault(target) {
  if (PLATFORM === "win32") return procs.launch("rundll32.exe", ["url.dll,FileProtocolHandler", target]);
  if (PLATFORM === "darwin") return procs.launch("open", [target]);
  return procs.launch("xdg-open", [target]);
}

const open_url = {
  name: "open_url", title: "Open web page", category: "apps", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Open an http(s) link in the default browser.",
  schema: { type: "object", properties: { url: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["url"] },
  describe: (p) => `Open ${p.url}`,
  async run({ url }, { cfg }) {
    const clean = validateUrl(url, cfg);
    openWithDefault(clean);
    return { ok: true, summary: `Opened ${clean}`, data: { url: clean } };
  },
};

const open_file = {
  name: "open_file", title: "Open file", category: "apps", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Open a file inside an approved folder with its default application (documents, drafts, .ics, .eml...). Executables are refused.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"] },
  describe: (p) => `Open ${p.path}`,
  async run({ path: p }, { cfg }) {
    const file = resolveApproved(cfg, p, { mustExist: true });
    if (/\.(exe|bat|cmd|ps1|vbs|js|msi|scr|com|jar|lnk|sh)$/i.test(file)) throw new Error("Opening executables or scripts this way is refused. Use run_command with approval.");
    openWithDefault(file);
    return { ok: true, summary: `Opened ${path.basename(file)}`, data: { path: file } };
  },
};

module.exports = { tools: [open_app, close_app, open_url, open_file], catalog, resolveApp, validateUrl, openWithDefault, BUILTIN };
