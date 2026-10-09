// Planner facade: local model when available, otherwise the rule planner.
// Either way the output is validated against the tool registry before the
// executor ever sees it.
const { rulePlan } = require("./rules");
const local = require("./local-model");
const { catalog } = require("../tools/apps");
const isolation = require("../isolation");

async function planCommand(command, { cfg, registry, signal, forceMock = false, onPartial }) {
  const ctx = { apps: catalog(cfg).filter((a) => a.available) };
  let raw, provider = "mock", model = null, notes = [];
  const resolved = forceMock ? { provider: "mock", reason: "forced" } : await local.resolve(cfg);
  if (resolved.provider !== "mock") {
    try {
      raw = await local.modelPlan(cfg, resolved, command, registry.list({ cfg }).filter((t) => t.availability.ok), { signal, onPartial });
      provider = resolved.provider;
      model = resolved.model;
    } catch (e) {
      notes.push(`${resolved.provider === "groq" ? "Groq" : "Local model"} failed (${e.message.slice(0, 160)}); used the rule planner instead.`);
      raw = rulePlan(command, ctx);
    }
  } else {
    raw = rulePlan(command, ctx);
    if (resolved.reason && !forceMock) notes.push(resolved.reason);
  }

  const actions = [];
  const dropped = [];
  const isolated = [];
  for (const a of raw.actions || []) {
    if (!a || typeof a.tool !== "string") { dropped.push("action without tool name"); continue; }
    const tool = registry.get(a.tool);
    if (!tool) { dropped.push(`unknown tool '${a.tool}'`); continue; }
    // A plan may name a tool isolation forbids — a model can write any name it
    // likes. It is dropped here, so it never reaches an approval screen.
    if (isolation.blocks(cfg, a.tool)) { isolated.push(a.tool); continue; }
    try {
      actions.push({ tool: a.tool, params: registry.validateParams(a.tool, a.params || {}) });
    } catch (e) {
      dropped.push(`${a.tool}: ${e.message}`);
    }
  }
  let message = (raw.message || "").trim();
  if (isolated.length && !actions.length) {
    // Everything asked for would touch the computer. Say that, plainly,
    // instead of a plan's cheerful first sentence followed by nothing.
    message = cfg.language === "he"
      ? "זה דורש גישה למחשב, והבידוד פעיל — ג'רביס לא מפעיל תוכנות ולא נוגע בקבצים. אפשר לכבות את הבידוד ב-Connections."
      : "That needs access to this computer, and isolation is on — JARVIS does not run programs or touch files. Isolation can be switched off in Connections.";
  } else if (isolated.length) {
    dropped.push(`${isolated.join(", ")}: blocked by isolation`);
  }
  if (!message) message = actions.length ? "Planned." : "Nothing to do.";
  if (dropped.length) message += ` (Dropped: ${dropped.join("; ")})`;
  return { message, actions, provider, model, mock: provider === "mock", notes, suggest: raw.suggest || null, unknown: !!raw.unknown };
}

module.exports = { planCommand, rulePlan, local };
