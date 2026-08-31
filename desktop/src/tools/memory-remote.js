const https = require("https");
const { URL } = require("url");
const { load } = require("../config");

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, timeout: 10000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function get(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    https.get(urlStr, { timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on("error", reject);
  });
}

async function memory_search({ query }) {
  const cfg = load();
  const res = await post(`${cfg.backendUrl}/memory/retrieve`, { query, userId: cfg.userId });
  const items = [...(res.core || []), ...(res.associative || [])];
  return items.length ? JSON.stringify(items) : "No relevant memories found.";
}

async function memory_write({ content, subject, type, salience }) {
  const cfg = load();
  const res = await post(`${cfg.backendUrl}/api/memory/store`, {
    userId: cfg.userId,
    content,
    subject: subject || null,
    type: type || "semantic",
    salience: salience || 3,
  });
  return JSON.stringify(res);
}

async function memory_forget({ subject, id, all }) {
  const cfg = load();
  if (id) {
    await post(`${cfg.backendUrl}/api/memory/delete`, { id });
    return `Deleted memory ${id}`;
  }
  if (all) {
    const res = await get(`${cfg.backendUrl}/memory?userId=${cfg.userId}`);
    for (const m of (res.memories || [])) {
      await post(`${cfg.backendUrl}/api/memory/delete`, { id: m.id });
    }
    return "All memories deleted.";
  }
  if (subject) {
    const res = await get(`${cfg.backendUrl}/memory?userId=${cfg.userId}`);
    const matches = (res.memories || []).filter((m) => m.subject === subject || (m.content && m.content.includes(subject)));
    for (const m of matches) {
      await post(`${cfg.backendUrl}/api/memory/delete`, { id: m.id });
    }
    return matches.length ? `Deleted ${matches.length} memories about "${subject}".` : `No memories found about "${subject}".`;
  }
  return "Specify subject, id, or all:true.";
}

const DEFS = [
  { name: "memory_search", description: "Search JARVIS memory for relevant information", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "memory_write", description: "Store a new memory (fact, preference, or event)", input_schema: { type: "object", properties: { content: { type: "string" }, subject: { type: "string" }, type: { type: "string", enum: ["semantic", "preference", "episodic", "procedural"] }, salience: { type: "integer", minimum: 1, maximum: 5 } }, required: ["content"] } },
  { name: "memory_forget", description: "Forget a memory by subject, id, or all", input_schema: { type: "object", properties: { subject: { type: "string" }, id: { type: "string" }, all: { type: "boolean" } }, required: [] } },
];

const RUNNERS = { memory_search, memory_write, memory_forget };
const ACTION_TYPES = { memory_search: "memory_search", memory_write: "memory_write", memory_forget: "memory_write" };

module.exports = { DEFS, RUNNERS, ACTION_TYPES };
