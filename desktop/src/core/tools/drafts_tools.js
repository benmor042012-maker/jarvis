// Email and calendar drafts as local files. Nothing is sent: the .eml/.ics is
// written to ~/.jarvis/drafts and can be opened with the default app.
const fs = require("fs");
const path = require("path");
const paths = require("../paths");

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function icsDate(d) { return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function icsEscape(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }

const create_email_draft = {
  name: "create_email_draft", title: "Email draft (.eml)", category: "drafts", risk: "low", reversible: true, timeoutMs: 5000,
  description: "Write an email draft as a .eml file in ~/.jarvis/drafts. DRAFT ONLY — NOTHING IS SENT.",
  schema: { type: "object", properties: { to: { type: "string", maxLength: 300, default: "" }, subject: { type: "string", maxLength: 300, default: "" }, body: { type: "string", minLength: 1, maxLength: 50000 } }, required: ["body"] },
  describe: (p) => `Email draft to ${p.to || "(no recipient)"}: ${p.subject || "(no subject)"}`,
  redact: (p) => ({ to: p.to ? "[recipient]" : "", subject_chars: (p.subject || "").length, body_chars: p.body.length }),
  async run({ to, subject, body }) {
    fs.mkdirSync(paths.DRAFTS, { recursive: true });
    const file = path.join(paths.DRAFTS, `email-${stamp()}.eml`);
    const eml = ["X-Unsent: 1", `To: ${to.replace(/[\r\n]/g, " ")}`, `Subject: ${subject.replace(/[\r\n]/g, " ")}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
    fs.writeFileSync(file, eml, "utf8");
    return { ok: true, summary: `Email draft saved (DRAFT ONLY — NOTHING IS SENT): ${path.basename(file)}`, data: { path: file, to, subject } };
  },
};

const create_calendar_draft = {
  name: "create_calendar_draft", title: "Calendar draft (.ics)", category: "drafts", risk: "low", reversible: true, timeoutMs: 5000,
  description: "Write a calendar event as a .ics file in ~/.jarvis/drafts. Nothing is added to any calendar until you open the file.",
  schema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 200 }, start_iso: { type: "string", minLength: 4, maxLength: 40 }, end_iso: { type: "string", maxLength: 40, default: "" }, location: { type: "string", maxLength: 300, default: "" }, description: { type: "string", maxLength: 5000, default: "" } }, required: ["title", "start_iso"] },
  describe: (p) => `Calendar draft: ${p.title} at ${p.start_iso}`,
  async run({ title, start_iso, end_iso, location, description }) {
    const start = Date.parse(start_iso);
    if (!Number.isFinite(start)) throw new Error("start_iso must be an ISO date-time.");
    const end = end_iso ? Date.parse(end_iso) : start + 3600000;
    if (!Number.isFinite(end) || end <= start) throw new Error("end_iso must be after the start.");
    fs.mkdirSync(paths.DRAFTS, { recursive: true });
    const file = path.join(paths.DRAFTS, `event-${stamp()}.ics`);
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JARVIS//local//EN", "BEGIN:VEVENT", `UID:${stamp()}@jarvis.local`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(title)}`, location ? `LOCATION:${icsEscape(location)}` : null, description ? `DESCRIPTION:${icsEscape(description)}` : null, "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
    fs.writeFileSync(file, ics, "utf8");
    return { ok: true, summary: `Calendar draft saved: ${path.basename(file)} (open it to add to your calendar)`, data: { path: file } };
  },
};

module.exports = { tools: [create_email_draft, create_calendar_draft] };
