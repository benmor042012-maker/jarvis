// File tools confined to approved folders. Deletion moves to ~/.jarvis/trash
// (reversible); overwriting an existing file is a separate high-risk step.
const fs = require("fs");
const path = require("path");
const paths = require("../paths");

const BLOCKED_NAMES = new Set([".env", ".git", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".pypirc", "credentials", "credentials.json", "config.json", "devices.json", "secrets.json"]);
const BLOCKED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".kdbx"];
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "$RECYCLE.BIN", "System Volume Information"]);
const MAX_READ = 200_000;

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function approvedRoots(cfg) {
  return (cfg.approvedFolders || [paths.WORKSPACE]).map((f) => realOrSelf(path.resolve(f))).filter(Boolean);
}

function inside(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Resolve a user/model supplied path against the approved folders. Relative
// paths are relative to the workspace. Symlink escapes are refused.
function resolveApproved(cfg, given, { mustExist = false } = {}) {
  const raw = String(given || "").trim();
  if (!raw || raw.includes("\0")) throw new Error("A file path is required.");
  if (raw.startsWith("~")) throw new Error("Home-relative paths are not allowed; use a full path inside an approved folder.");
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.join(paths.WORKSPACE, raw);
  for (const part of abs.split(/[\\/]/)) {
    const low = part.toLowerCase();
    if (BLOCKED_NAMES.has(low) || BLOCKED_SUFFIXES.some((s) => low.endsWith(s)) || low.startsWith(".git")) {
      throw new Error(`Access to '${part}' is blocked (secrets and repository internals are never touched).`);
    }
  }
  // Resolve the deepest existing ancestor to defeat symlink tricks.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = realOrSelf(probe) || probe;
  const real = path.join(realProbe, path.relative(probe, abs));
  const roots = approvedRoots(cfg);
  if (!roots.some((r) => inside(real, r))) {
    throw new Error(`'${abs}' is outside the approved folders (${roots.join("; ")}). Add the folder in Settings first.`);
  }
  if (mustExist && !fs.existsSync(real)) throw new Error(`'${abs}' does not exist.`);
  return real;
}

function shortPath(p) {
  return p.length > 120 ? "…" + p.slice(-118) : p;
}

const list_files = {
  name: "list_files", title: "List files", category: "files", risk: "low", reversible: true, timeoutMs: 10000,
  description: "List files and folders inside an approved folder (default: the JARVIS workspace).",
  schema: { type: "object", properties: { folder: { type: "string", maxLength: 1024, default: "" } } },
  describe: (p) => `List files in ${p.folder || "the workspace"}`,
  async run({ folder }, { cfg }) {
    const dir = resolveApproved(cfg, folder || paths.WORKSPACE, { mustExist: true });
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
    return { ok: true, summary: `${entries.length} item(s) in ${shortPath(dir)}`, data: { folder: dir, entries } };
  },
};

const read_file = {
  name: "read_file", title: "Read file", category: "files", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Read a text file inside an approved folder.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"] },
  describe: (p) => `Read ${p.path}`,
  redact: (p) => ({ path: p.path }),
  async run({ path: p }, { cfg }) {
    const file = resolveApproved(cfg, p, { mustExist: true });
    if (!fs.statSync(file).isFile()) throw new Error(`${p} is not a file.`);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size, MAX_READ));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { throw new Error(`${p} is not a UTF-8 text file.`); }
    return { ok: true, summary: `Read ${shortPath(file)} (${size} bytes${size > MAX_READ ? ", truncated" : ""})`, data: { path: file, content: text, truncated: size > MAX_READ } };
  },
};

const write_file = {
  name: "write_file", title: "Create text file", category: "files", risk: "medium", reversible: true, timeoutMs: 10000,
  description: "Create a new text file inside an approved folder. Never overwrites: use overwrite_file for that.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, content: { type: "string", maxLength: 500000, default: "" } }, required: ["path"] },
  describe: (p) => `Create ${p.path} (${(p.content || "").length} chars)`,
  redact: (p) => ({ path: p.path, bytes: Buffer.byteLength(p.content || "", "utf8") }),
  async run({ path: p, content }, { cfg }) {
    const file = resolveApproved(cfg, p);
    if (fs.existsSync(file)) throw new Error(`${p} already exists. Ask for overwrite_file if you really want to replace it.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content || "", { encoding: "utf8", flag: "wx" });
    return { ok: true, summary: `Created ${shortPath(file)}`, data: { path: file } };
  },
};

const overwrite_file = {
  name: "overwrite_file", title: "Overwrite file", category: "files", risk: "high", reversible: true, timeoutMs: 10000,
  description: "Replace the contents of an existing file inside an approved folder. The previous version is kept in the trash.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, content: { type: "string", maxLength: 500000 } }, required: ["path", "content"] },
  describe: (p) => `Overwrite ${p.path}`,
  redact: (p) => ({ path: p.path, bytes: Buffer.byteLength(p.content || "", "utf8") }),
  async run({ path: p, content }, { cfg }) {
    const file = resolveApproved(cfg, p, { mustExist: true });
    const backup = trashCopy(file);
    fs.writeFileSync(file, content, "utf8");
    return { ok: true, summary: `Overwrote ${shortPath(file)} (previous version in trash)`, data: { path: file, backup } };
  },
};

const create_folder = {
  name: "create_folder", title: "Create folder", category: "files", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Create a folder inside an approved folder.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"] },
  describe: (p) => `Create folder ${p.path}`,
  async run({ path: p }, { cfg }) {
    const dir = resolveApproved(cfg, p);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, summary: `Folder ready: ${shortPath(dir)}`, data: { path: dir } };
  },
};

const search_files = {
  name: "search_files", title: "Search files", category: "files", risk: "low", reversible: true, timeoutMs: 20000,
  description: "Search file names inside an approved folder (case-insensitive substring).",
  schema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, folder: { type: "string", maxLength: 1024, default: "" }, max_results: { type: "integer", minimum: 1, maximum: 500, default: 50 } }, required: ["query"] },
  describe: (p) => `Search for "${p.query}"`,
  async run({ query, folder, max_results }, { cfg, signal }) {
    const root = resolveApproved(cfg, folder || paths.WORKSPACE, { mustExist: true });
    const q = query.toLowerCase();
    const hits = [];
    const walk = (dir, depth) => {
      if (depth > 8 || hits.length >= max_results || signal?.aborted) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= max_results) return;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(q)) hits.push(full);
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
      }
    };
    walk(root, 0);
    return { ok: true, summary: `Found ${hits.length} match(es) for "${query}"`, data: { matches: hits, root } };
  },
};

const move_file = {
  name: "move_file", title: "Move / rename", category: "files", risk: "medium", reversible: true, timeoutMs: 10000,
  description: "Move or rename a file or folder between approved folders. Never overwrites the destination.",
  schema: { type: "object", properties: { from: { type: "string", minLength: 1, maxLength: 1024 }, to: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["from", "to"] },
  describe: (p) => `Move ${p.from} → ${p.to}`,
  async run({ from, to }, { cfg }) {
    const src = resolveApproved(cfg, from, { mustExist: true });
    const dst = resolveApproved(cfg, to);
    if (fs.existsSync(dst)) throw new Error(`${to} already exists.`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, summary: `Moved to ${shortPath(dst)}`, data: { from: src, to: dst } };
  },
};

function trashCopy(file) {
  fs.mkdirSync(paths.TRASH, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(paths.TRASH, `${stamp}-${path.basename(file)}`);
  fs.cpSync(file, dest, { recursive: true });
  return dest;
}

const delete_file = {
  name: "delete_file", title: "Delete (to trash)", category: "files", risk: "high", reversible: true, timeoutMs: 20000,
  description: "Move a file or folder inside an approved folder to the JARVIS trash (~/.jarvis/trash). Nothing is erased permanently.",
  schema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"] },
  describe: (p) => `Move ${p.path} to trash`,
  async run({ path: p }, { cfg }) {
    const target = resolveApproved(cfg, p, { mustExist: true });
    const dest = trashCopy(target);
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, summary: `Moved to trash: ${shortPath(dest)}`, data: { path: target, trash: dest } };
  },
};

const empty_trash_info = {
  name: "list_trash", title: "List trash", category: "files", risk: "low", reversible: true, timeoutMs: 5000,
  description: "List files JARVIS moved to its trash.",
  schema: { type: "object", properties: {} },
  async run() {
    fs.mkdirSync(paths.TRASH, { recursive: true });
    const entries = fs.readdirSync(paths.TRASH).slice(0, 500);
    return { ok: true, summary: `${entries.length} item(s) in trash`, data: { folder: paths.TRASH, entries } };
  },
};

module.exports = { tools: [list_files, read_file, write_file, overwrite_file, create_folder, search_files, move_file, delete_file, empty_trash_info], resolveApproved, approvedRoots };
