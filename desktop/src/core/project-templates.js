// Deterministic project templates: complete, buildable starting points with
// zero paid or cloud dependencies. Each returns {path, content}[] plus the
// commands JARVIS may run (after approval).
const { sha256 } = require("./util");

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const NODE_TEST = ["node", "--test"];

const TEMPLATES = {
  website: {
    id: "website", title: { he: "אתר סטטי", en: "Static website" }, description: "HTML/CSS/JS site with a test that checks the pages are valid. No build step needed; opens offline.",
    install: null, test: NODE_TEST, build: null,
    files: ({ name, description }) => [
      { path: "index.html", content: `<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(name)}</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<header><h1>${esc(name)}</h1><nav><a href="#about">אודות</a> <a href="#contact">צור קשר</a></nav></header>\n<main>\n<section id="about"><h2>אודות</h2><p>${esc(description || "אתר חדש שנבנה מקומית עם JARVIS.")}</p></section>\n<section id="contact"><h2>צור קשר</h2><form onsubmit="return false"><label>שם <input name="name" required></label><label>הודעה <textarea name="message" required></textarea></label><button type="submit">שלח</button><p class="note">הטופס הזה לא שולח כלום עד שתחבר אותו לשרת משלך.</p></form></section>\n</main>\n<footer><small>© ${new Date().getFullYear()} ${esc(name)}</small></footer>\n<script src="app.js"></script>\n</body>\n</html>\n` },
      { path: "styles.css", content: `:root{--bg:#050b18;--fg:#eaf6ff;--accent:#3ecbff}\n*{box-sizing:border-box}\nbody{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);line-height:1.6}\nheader,main,footer{max-width:900px;margin:0 auto;padding:16px}\nheader{display:flex;justify-content:space-between;align-items:center}\nnav a{color:var(--accent);margin-inline-start:12px}\nform{display:grid;gap:12px;max-width:480px}\ninput,textarea{width:100%;padding:8px;border-radius:8px;border:1px solid #234;background:#0a1424;color:var(--fg)}\nbutton{padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#031;font-weight:700;cursor:pointer}\n.note{font-size:12px;opacity:.7}\n@media (prefers-reduced-motion:no-preference){button:hover{filter:brightness(1.1)}}\n` },
      { path: "app.js", content: `document.querySelector("form")?.addEventListener("submit", (e) => { e.preventDefault(); alert("תודה! (הטופס אינו מחובר לשרת)"); });\n` },
      { path: "test/site.test.js", content: `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst root = path.join(__dirname, "..");\ntest("index.html has a title and links its assets", () => {\n  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");\n  assert.match(html, /<title>.+<\\/title>/);\n  assert.match(html, /styles\\.css/);\n  assert.match(html, /app\\.js/);\n  assert.ok(fs.existsSync(path.join(root, "styles.css")));\n  assert.ok(fs.existsSync(path.join(root, "app.js")));\n});\n` },
      { path: "package.json", content: JSON.stringify({ name, version: "0.1.0", private: true, description: description || "", scripts: { test: "node --test" }, license: "MIT" }, null, 2) + "\n" },
      { path: "README.md", content: `# ${name}\n\n${description || ""}\n\nOpen \`index.html\` in a browser. Tests: \`npm test\` (Node 18+).\n` },
    ],
  },
  api: {
    id: "api", title: { he: "API / שרת", en: "API / backend service" }, description: "Node http API with JSON routes, a health endpoint and tests. No dependencies.",
    install: null, test: NODE_TEST, build: null,
    files: ({ name, description }) => [
      { path: "server.js", content: `const http = require("http");\nconst items = [];\nfunction json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }\nconst server = http.createServer((req, res) => {\n  const url = new URL(req.url, "http://localhost");\n  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: ${JSON.stringify(name)} });\n  if (req.method === "GET" && url.pathname === "/items") return json(res, 200, items);\n  if (req.method === "POST" && url.pathname === "/items") {\n    let body = ""; req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });\n    req.on("end", () => { try { const item = JSON.parse(body); if (!item || typeof item.name !== "string") return json(res, 400, { error: "name required" }); const created = { id: items.length + 1, name: item.name }; items.push(created); json(res, 201, created); } catch { json(res, 400, { error: "bad json" }); } });\n    return;\n  }\n  json(res, 404, { error: "not found" });\n});\nif (require.main === module) { const port = Number(process.env.PORT) || 3000; server.listen(port, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + port)); }\nmodule.exports = { server };\n` },
      { path: "test/api.test.js", content: `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { server } = require("../server");\ntest("health and items", async () => {\n  await new Promise((r) => server.listen(0, "127.0.0.1", r));\n  const base = "http://127.0.0.1:" + server.address().port;\n  const h = await (await fetch(base + "/health")).json();\n  assert.equal(h.ok, true);\n  const c = await fetch(base + "/items", { method: "POST", body: JSON.stringify({ name: "a" }), headers: { "content-type": "application/json" } });\n  assert.equal(c.status, 201);\n  const list = await (await fetch(base + "/items")).json();\n  assert.equal(list.length, 1);\n  server.close();\n});\n` },
      { path: "package.json", content: JSON.stringify({ name, version: "0.1.0", private: true, description: description || "", main: "server.js", scripts: { start: "node server.js", test: "node --test" }, license: "MIT" }, null, 2) + "\n" },
      { path: "README.md", content: `# ${name}\n\n${description || ""}\n\n\`npm start\` → http://127.0.0.1:3000/health\n\n\`npm test\`\n` },
    ],
  },
  desktop: {
    id: "desktop", title: { he: "אפליקציית שולחן עבודה (Electron)", en: "Desktop app (Electron)" }, description: "Electron shell around an HTML UI. Running it needs `npm install` (downloads Electron, open source) — offline mode skips that step.",
    install: ["npm", "install", "--no-audit", "--no-fund"], test: NODE_TEST, build: null,
    files: ({ name, description }) => [
      { path: "main.js", content: `const { app, BrowserWindow } = require("electron");\nconst path = require("path");\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ width: 900, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false } });\n  win.loadFile(path.join(__dirname, "ui", "index.html"));\n});\napp.on("window-all-closed", () => app.quit());\n` },
      { path: "ui/index.html", content: `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font-family:system-ui;background:#050b18;color:#eaf6ff;padding:24px}</style></head><body><h1>${esc(name)}</h1><p>${esc(description || "")}</p></body></html>\n` },
      { path: "test/smoke.test.js", content: `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst { execFileSync } = require("node:child_process");\nconst root = path.join(__dirname, "..");\ntest("the UI exists and main.js is valid JavaScript", () => {\n  assert.ok(fs.existsSync(path.join(root, "ui", "index.html")));\n  execFileSync(process.execPath, ["--check", path.join(root, "main.js")]);\n});\n` },
      { path: "package.json", content: JSON.stringify({ name, version: "0.1.0", private: true, description: description || "", main: "main.js", scripts: { start: "electron .", test: "node --test" }, devDependencies: { electron: "^33.0.0" }, license: "MIT" }, null, 2) + "\n" },
      { path: "README.md", content: `# ${name}\n\n${description || ""}\n\n\`npm install\` (once, online) then \`npm start\`.\n` },
    ],
  },
  mobile: {
    id: "mobile", title: { he: "אפליקציית מובייל (PWA)", en: "Mobile app (PWA)" }, description: "Installable progressive web app: manifest, service worker, offline cache. Native store builds need Android Studio/Xcode, which are not bundled.",
    install: null, test: NODE_TEST, build: null,
    files: ({ name, description }) => [
      { path: "index.html", content: `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><link rel="manifest" href="manifest.json"><meta name="theme-color" content="#050b18"><style>body{margin:0;font-family:system-ui;background:#050b18;color:#eaf6ff;padding:24px}button{padding:12px 20px;border-radius:12px;border:0;background:#3ecbff;font-weight:700}</style></head><body><h1>${esc(name)}</h1><p>${esc(description || "")}</p><button id="count">לחצת 0 פעמים</button><script>let n=0;count.onclick=()=>{count.textContent="לחצת "+(++n)+" פעמים"};if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js");</script></body></html>\n` },
      { path: "manifest.json", content: JSON.stringify({ name, short_name: name.slice(0, 12), start_url: "./index.html", display: "standalone", background_color: "#050b18", theme_color: "#050b18", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, null, 2) + "\n" },
      { path: "icon.svg", content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#050b18" stroke="#3ecbff" stroke-width="3"/><circle cx="32" cy="32" r="10" fill="#3ecbff"/></svg>\n` },
      { path: "sw.js", content: `const CACHE = "${name}-v1";\nconst ASSETS = ["./index.html", "./manifest.json", "./icon.svg"];\nself.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));\nself.addEventListener("fetch", (e) => e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))));\n` },
      { path: "test/pwa.test.js", content: `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\ntest("manifest is valid and referenced", () => {\n  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));\n  assert.ok(m.name && m.start_url);\n  assert.match(fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8"), /manifest\\.json/);\n});\n` },
      { path: "package.json", content: JSON.stringify({ name, version: "0.1.0", private: true, scripts: { test: "node --test" }, license: "MIT" }, null, 2) + "\n" },
      { path: "README.md", content: `# ${name}\n\nServe the folder over http(s) and "Add to home screen". Native Android/iOS builds require Android Studio / Xcode (not included).\n` },
    ],
  },
  installer: {
    id: "installer", title: { he: "חבילת התקנה (electron-builder)", en: "Installer package (electron-builder)" }, description: "Adds an installer configuration to a desktop project. Building an installer downloads electron-builder (open source) the first time and cannot run in offline mode.",
    install: ["npm", "install", "--no-audit", "--no-fund"], test: NODE_TEST, build: null,
    files: ({ name }) => [
      { path: "electron-builder.yml", content: `appId: local.${name}\nproductName: ${name}\ndirectories:\n  output: dist\nwin:\n  target: nsis\nlinux:\n  target: AppImage\nmac:\n  target: dmg\n` },
      { path: "main.js", content: `const { app, BrowserWindow } = require("electron");\napp.whenReady().then(() => { const w = new BrowserWindow({ width: 800, height: 600 }); w.loadURL("data:text/html,<h1>${esc(name)}</h1>"); });\napp.on("window-all-closed", () => app.quit());\n` },
      { path: "test/config.test.js", content: `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\ntest("builder config present", () => { assert.match(fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8"), /appId/); });\n` },
      { path: "package.json", content: JSON.stringify({ name, version: "0.1.0", private: true, main: "main.js", scripts: { start: "electron .", test: "node --test", "build:win": "electron-builder --win", "build:linux": "electron-builder --linux" }, devDependencies: { electron: "^33.0.0", "electron-builder": "^25.0.0" }, license: "MIT" }, null, 2) + "\n" },
      { path: "README.md", content: `# ${name}\n\n\`npm install\` once (online), then \`npm run build:win\` produces \`dist/\`. Distribution/upload is manual: JARVIS never publishes.\n` },
    ],
  },
};

function list() { return Object.values(TEMPLATES).map((t) => ({ id: t.id, title: t.title, description: t.description, needs_network_install: !!t.install })); }
function get(id) { return TEMPLATES[id] || null; }

module.exports = { list, get, TEMPLATES, fingerprint: () => sha256(Object.keys(TEMPLATES).join(",")) };
