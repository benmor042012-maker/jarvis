// Isolation: what JARVIS may never do to this computer.
//
// With isolation on (the default), the only tools that exist for the planner
// — whichever brain is planning, local or Groq — are the ones that cannot
// touch the machine: the time, arithmetic, JARVIS's own notes, reminders and
// drafts (all inside ~/.jarvis), a read-only look at memory and disk, and the
// contact list. Everything that would run a program, a shell, a script, type,
// click, read the screen or the clipboard, open a file or a browser, or write
// anywhere outside ~/.jarvis is reported unavailable, with this reason, at
// every layer: the planner never sees it, the plan marks it refused, and the
// executor will not run it even if a plan names it.
//
// This is an allow-list on purpose. A tool added later is isolated until
// someone decides, here, that it is safe — never the other way round.
const SAFE_TOOLS = new Set([
  "current_time",
  "calculate",
  "remember",
  "recall",
  "forget",
  "set_reminder",
  "list_reminders",
  "cancel_reminder",
  "create_email_draft",
  "create_calendar_draft",
  "system_status",
  "note_add",
  "notes_today",
  "contacts_list",
]);

const REASON =
  "Isolation is on: JARVIS cannot run programs, shells or scripts, touch your files, keyboard, mouse, screen, clipboard or browser. Only its own notes, reminders and drafts are allowed. Turn isolation off in Connections if you want this back.";

function enabled(cfg) {
  return cfg?.isolation !== false;
}

/** null when the tool may run; the reason when isolation forbids it. */
function blocks(cfg, toolName) {
  if (!enabled(cfg)) return null;
  return SAFE_TOOLS.has(toolName) ? null : REASON;
}

module.exports = { SAFE_TOOLS, REASON, enabled, blocks };
