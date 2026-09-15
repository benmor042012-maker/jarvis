// Deterministic helpers that need no model and no network: time, math, local
// memory notes and local reminders.
const paths = require("../paths");

function safeEval(expr) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => { if (peek() !== t) throw new Error(`Expected ${t}`); pos++; };
  const fns = { sqrt: Math.sqrt, abs: Math.abs, log: Math.log, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, pow: Math.pow, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil };
  const consts = { pi: Math.PI, e: Math.E };
  function expr_() { let v = term(); while (peek() === "+" || peek() === "-") { const op = tokens[pos++]; const r = term(); v = op === "+" ? v + r : v - r; } return v; }
  function term() { let v = pow(); while (peek() === "*" || peek() === "/" || peek() === "%") { const op = tokens[pos++]; const r = pow(); v = op === "*" ? v * r : op === "/" ? v / r : v % r; } return v; }
  function pow() { const v = unary(); if (peek() === "^") { pos++; return Math.pow(v, pow()); } return v; }
  function unary() { if (peek() === "-") { pos++; return -unary(); } return atom(); }
  function atom() {
    const t = peek();
    if (t === undefined) throw new Error("Unexpected end of expression");
    if (t === "(") { pos++; const v = expr_(); eat(")"); return v; }
    if (!isNaN(Number(t))) { pos++; return Number(t); }
    if (consts[t] !== undefined) { pos++; return consts[t]; }
    if (fns[t]) { pos++; eat("("); const args = [expr_()]; while (peek() === ",") { pos++; args.push(expr_()); } eat(")"); return fns[t](...args); }
    throw new Error(`Unexpected: ${t}`);
  }
  const r = expr_();
  if (pos < tokens.length) throw new Error("Unexpected trailing input");
  return r;
}

function tokenize(s) {
  const r = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if ("+-*/%^(),".includes(s[i])) { r.push(s[i++]); continue; }
    if (/[0-9.]/.test(s[i])) { let n = ""; while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++]; r.push(n); continue; }
    if (/[a-z]/i.test(s[i])) { let w = ""; while (i < s.length && /[a-z]/i.test(s[i])) w += s[i++]; r.push(w.toLowerCase()); continue; }
    throw new Error(`Unexpected character '${s[i]}'`);
  }
  return r;
}

const current_time = {
  name: "current_time", title: "Current time", category: "info", risk: "low", reversible: true, timeoutMs: 2000,
  description: "Current date and time.",
  schema: { type: "object", properties: { timezone: { type: "string", maxLength: 64, default: "" } } },
  async run({ timezone }) {
    const now = new Date();
    let text;
    try { text = new Intl.DateTimeFormat("he-IL", { dateStyle: "full", timeStyle: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(now); } catch { text = now.toString(); }
    return { ok: true, summary: text, data: { iso: now.toISOString() } };
  },
};

const calculate = {
  name: "calculate", title: "Calculate", category: "info", risk: "low", reversible: true, timeoutMs: 2000,
  description: "Evaluate an arithmetic expression (+ - * / % ^, sqrt, sin, cos, pi...).",
  schema: { type: "object", properties: { expression: { type: "string", minLength: 1, maxLength: 500 } }, required: ["expression"] },
  describe: (p) => `Calculate ${p.expression}`,
  async run({ expression }) {
    const v = safeEval(expression);
    return { ok: true, summary: `${expression} = ${v}`, data: { value: v } };
  },
};

function loadMemory() { return paths.readJson(paths.MEMORY, []); }
function saveMemory(list) { paths.writeJson(paths.MEMORY, list); }

const remember = {
  name: "remember", title: "Remember", category: "memory", risk: "low", reversible: true, timeoutMs: 2000,
  description: "Save a note to local memory (~/.jarvis/memory.json).",
  schema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["text"] },
  describe: (p) => `Remember: ${p.text.slice(0, 60)}`,
  async run({ text }) {
    const list = loadMemory();
    list.push({ id: Date.now().toString(36), text, at: new Date().toISOString() });
    saveMemory(list.slice(-1000));
    return `Saved to memory (${list.length} notes)`;
  },
};

const recall = {
  name: "recall", title: "Recall", category: "memory", risk: "low", reversible: true, timeoutMs: 2000,
  description: "Search local memory notes.",
  schema: { type: "object", properties: { query: { type: "string", maxLength: 200, default: "" } } },
  describe: (p) => (p.query ? `Recall "${p.query}"` : "List memory"),
  async run({ query }) {
    const q = (query || "").toLowerCase();
    const list = loadMemory().filter((m) => !q || m.text.toLowerCase().includes(q)).slice(-20);
    return { ok: true, summary: list.length ? list.map((m) => `• ${m.text}`).join("\n") : "Nothing in memory matches.", data: { notes: list } };
  },
};

const forget = {
  name: "forget", title: "Forget", category: "memory", risk: "medium", reversible: false, timeoutMs: 2000,
  description: "Delete memory notes matching a text (or all notes with query '*').",
  schema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"] },
  describe: (p) => `Forget "${p.query}"`,
  async run({ query }) {
    const list = loadMemory();
    const keep = query === "*" ? [] : list.filter((m) => !m.text.toLowerCase().includes(query.toLowerCase()));
    saveMemory(keep);
    return `Removed ${list.length - keep.length} note(s)`;
  },
};

function loadReminders() { return paths.readJson(paths.REMINDERS, []); }
function saveReminders(list) { paths.writeJson(paths.REMINDERS, list); }

const set_reminder = {
  name: "set_reminder", title: "Set reminder", category: "memory", risk: "low", reversible: true, timeoutMs: 2000,
  description: "Set a local reminder (shown as a notification by the JARVIS window/tray).",
  schema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 500 }, at_iso: { type: "string", maxLength: 40, default: "" }, in_minutes: { type: "integer", minimum: 1, maximum: 100000, default: 0 } }, required: ["text"] },
  describe: (p) => `Reminder: ${p.text}`,
  async run({ text, at_iso, in_minutes }) {
    let at = at_iso ? Date.parse(at_iso) : NaN;
    if (!Number.isFinite(at) && in_minutes) at = Date.now() + in_minutes * 60000;
    if (!Number.isFinite(at)) throw new Error("Give at_iso or in_minutes.");
    const list = loadReminders();
    const r = { id: Date.now().toString(36), text, at: new Date(at).toISOString(), fired: false };
    list.push(r);
    saveReminders(list.slice(-500));
    return { ok: true, summary: `Reminder set for ${new Date(at).toLocaleString("he-IL")}`, data: { reminder: r } };
  },
};

const list_reminders = {
  name: "list_reminders", title: "List reminders", category: "memory", risk: "low", reversible: true, timeoutMs: 2000,
  description: "List pending reminders.",
  schema: { type: "object", properties: {} },
  async run() {
    const list = loadReminders().filter((r) => !r.fired);
    return { ok: true, summary: list.length ? list.map((r) => `• ${new Date(r.at).toLocaleString("he-IL")}: ${r.text}`).join("\n") : "No pending reminders.", data: { reminders: list } };
  },
};

const cancel_reminder = {
  name: "cancel_reminder", title: "Cancel reminder", category: "memory", risk: "low", reversible: false, timeoutMs: 2000,
  description: "Cancel a reminder by id or matching text.",
  schema: { type: "object", properties: { id_or_text: { type: "string", minLength: 1, maxLength: 200 } }, required: ["id_or_text"] },
  describe: (p) => `Cancel reminder ${p.id_or_text}`,
  async run({ id_or_text }) {
    const list = loadReminders();
    const keep = list.filter((r) => r.id !== id_or_text && !r.text.toLowerCase().includes(id_or_text.toLowerCase()));
    saveReminders(keep);
    return `Cancelled ${list.length - keep.length} reminder(s)`;
  },
};

// Called by the host on a timer: returns reminders that are due and marks them.
function dueReminders() {
  const list = loadReminders();
  const now = Date.now();
  const due = list.filter((r) => !r.fired && Date.parse(r.at) <= now);
  if (due.length) {
    for (const r of due) r.fired = true;
    saveReminders(list);
  }
  return due;
}

module.exports = { tools: [current_time, calculate, remember, recall, forget, set_reminder, list_reminders, cancel_reminder], safeEval, dueReminders };
