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
    https.get(urlStr, { timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on("error", reject);
  });
}

async function reminder_set({ text, at_iso, in_seconds }) {
  const cfg = load();
  const res = await post(`${cfg.backendUrl}/api/reminders`, {
    userId: cfg.userId,
    text,
    at_iso,
    in_seconds,
  });
  return JSON.stringify(res);
}

async function reminder_list() {
  const cfg = load();
  const res = await get(`${cfg.backendUrl}/api/reminders?userId=${cfg.userId}`);
  return JSON.stringify(res);
}

async function reminder_cancel({ id }) {
  const cfg = load();
  const res = await post(`${cfg.backendUrl}/api/reminders/${id}/cancel`, { userId: cfg.userId });
  return JSON.stringify(res);
}

const DEFS = [
  { name: "reminder_set", description: "Set a reminder", input_schema: { type: "object", properties: { text: { type: "string" }, at_iso: { type: "string", description: "ISO datetime for the reminder" }, in_seconds: { type: "integer", description: "Seconds from now" } }, required: ["text"] } },
  { name: "reminder_list", description: "List active reminders", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "reminder_cancel", description: "Cancel a reminder by ID", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const RUNNERS = { reminder_set, reminder_list, reminder_cancel };
const ACTION_TYPES = { reminder_set: "create_event", reminder_list: "memory_search", reminder_cancel: "change_settings" };

module.exports = { DEFS, RUNNERS, ACTION_TYPES };
