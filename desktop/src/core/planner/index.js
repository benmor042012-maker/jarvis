// Planner facade: local model when available, otherwise the rule planner.
// Either way the output is validated against the tool registry before the
// executor ever sees it.
const { rulePlan } = require("./rules");
const local = require("./local-model");
const { catalog } = require("../tools/apps");

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
      notes.push(`Local model failed (${e.message.slice(0, 120)}); used the rule planner instead.`);
      raw = rulePlan(command, ctx);
    }
  } else {
    raw = rulePlan(command, ctx);
    if (resolved.reason && !forceMock) notes.push(resolved.reason);
  }

  const actions = [];
  const dropped = [];
  for (const a of raw.actions || []) {
    if (!a || typeof a.tool !== "string") { dropped.push("action without tool name"); continue; }
    const tool = registry.get(a.tool);
    if (!tool) { dropped.push(`unknown tool '${a.tool}'`); continue; }
    try {
      actions.push({ tool: a.tool, params: registry.validateParams(a.tool, a.params || {}) });
    } catch (e) {
      dropped.push(`${a.tool}: ${e.message}`);
    }
  }
  let message = (raw.message || "").trim();
  if (!message) message = actions.length ? "Planned." : "Nothing to do.";
  if (dropped.length) message += ` (Dropped: ${dropped.join("; ")})`;
  return { message, actions, provider, model, mock: provider === "mock", notes, suggest: raw.suggest || null, unknown: !!raw.unknown };
}

module.exports = { planCommand, rulePlan, local };
