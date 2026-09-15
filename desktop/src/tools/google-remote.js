// Google Calendar + Gmail for the desktop agent.
// The OAuth tokens live in the Cloudflare Worker (free), so the desktop app
// just proxies tool calls to POST /api/tools/:name. Connect once by opening
// <backendUrl>/google/auth in a browser.

const https = require("https");
const { URL } = require("url");
const { load } = require("../config");

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, timeout: 30000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function remote(name) {
  return async (input) => {
    const cfg = load();
    const res = await post(`${cfg.backendUrl}/api/tools/${name}`, { userId: cfg.userId, input: input || {} });
    if (res && res.not_connected) {
      res.hint = `Google לא מחובר. פתח בדפדפן: ${cfg.backendUrl}/google/auth?userId=${cfg.userId}`;
    }
    return JSON.stringify(res);
  };
}

const ISO = { type: "string", description: "ISO 8601 with timezone, e.g. 2026-09-16T10:00:00+03:00" };

const DEFS = [
  { name: "calendar_list_events", description: "List Google Calendar events in a range (default: next 7 days). Use for 'what do I have today / this week / when is my meeting with X'.",
    input_schema: { type: "object", properties: { from_iso: ISO, to_iso: ISO, query: { type: "string" }, max_results: { type: "integer" } }, required: [] } },
  { name: "calendar_create_event", description: "Create a Google Calendar event. Only when the user explicitly asked to schedule something.",
    input_schema: { type: "object", properties: { title: { type: "string" }, start_iso: ISO, end_iso: ISO, all_day_date: { type: "string", description: "YYYY-MM-DD for all-day events" }, location: { type: "string" }, description: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, reminder_minutes: { type: "integer" } }, required: ["title"] } },
  { name: "calendar_update_event", description: "Move/rename/edit an existing event by event_id (from calendar_list_events).",
    input_schema: { type: "object", properties: { event_id: { type: "string" }, title: { type: "string" }, start_iso: ISO, end_iso: ISO, location: { type: "string" }, description: { type: "string" } }, required: ["event_id"] } },
  { name: "calendar_delete_event", description: "Delete an event by event_id. Only when the user explicitly asked to cancel it.",
    input_schema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] } },
  { name: "calendar_find_free_time", description: "Find free slots of N minutes within work hours over the next days.",
    input_schema: { type: "object", properties: { duration_minutes: { type: "integer" }, from_iso: ISO, to_iso: ISO, work_start_hour: { type: "integer" }, work_end_hour: { type: "integer" } }, required: ["duration_minutes"] } },
  { name: "gmail_search", description: "Search Gmail with Gmail query syntax (default: unread from last 24h). Returns sender, subject, date, snippet, message_id.",
    input_schema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: [] } },
  { name: "gmail_read", description: "Read a full email body by message_id.",
    input_schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "gmail_create_draft", description: "Create a Gmail DRAFT (never sends). With reply_to_message_id it becomes a reply in the same thread.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to_message_id: { type: "string" } }, required: ["body"] } },
  { name: "gmail_send", description: "Actually send an email. ONLY when the user explicitly said to send, after seeing recipient and text. Otherwise use gmail_create_draft.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to_message_id: { type: "string" } }, required: ["to", "body"] } },
  { name: "gmail_modify", description: "mark_read / mark_unread / archive / star / unstar / trash a message.",
    input_schema: { type: "object", properties: { message_id: { type: "string" }, action: { type: "string", enum: ["mark_read", "mark_unread", "archive", "star", "unstar", "trash"] } }, required: ["message_id", "action"] } },
];

const RUNNERS = Object.fromEntries(DEFS.map((d) => [d.name, remote(d.name)]));

// Permission levels: reads are SAFE, calendar writes ASK, sending mail CONFIRM.
const ACTION_TYPES = {
  calendar_list_events: "memory_search",
  calendar_find_free_time: "memory_search",
  calendar_create_event: "create_event",
  calendar_update_event: "create_event",
  calendar_delete_event: "create_event",
  gmail_search: "read_messages",
  gmail_read: "read_messages",
  gmail_create_draft: "create_event",
  gmail_send: "send_message",
  gmail_modify: "create_event",
};

module.exports = { DEFS, RUNNERS, ACTION_TYPES };
