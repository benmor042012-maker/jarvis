// Typed tool registry. Every tool declares: schema, risk, reversibility,
// timeout, platform availability, a redaction policy for the audit log and a
// run(params, ctx) implementation that honors ctx.signal for cancellation.
const os = require("os");
const { validate, SchemaError } = require("./schema");

const RISKS = new Set(["low", "medium", "high"]);

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    for (const key of ["name", "description", "schema", "risk", "run"]) {
      if (tool[key] === undefined) throw new Error(`tool ${tool.name || "?"} is missing ${key}`);
    }
    if (!RISKS.has(tool.risk)) throw new Error(`tool ${tool.name} has invalid risk ${tool.risk}`);
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} registered twice`);
    this.tools.set(tool.name, {
      timeoutMs: 30000,
      reversible: false,
      platforms: null,
      category: "general",
      redact: (p) => p,
      ...tool,
    });
    return this;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  availability(tool, ctx = {}) {
    if (tool.platforms && !tool.platforms.includes(os.platform())) {
      return { ok: false, reason: `Only available on ${tool.platforms.map(platformLabel).join("/")}; this computer runs ${platformLabel(os.platform())}.` };
    }
    if (typeof tool.available === "function") {
      try {
        const r = tool.available(ctx);
        if (r && r.ok === false) return { ok: false, reason: r.reason || "unavailable" };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }
    return { ok: true };
  }

  list(ctx = {}) {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      title: t.title || t.name,
      description: t.description,
      category: t.category,
      risk: t.risk,
      reversible: !!t.reversible,
      timeout_ms: t.timeoutMs,
      schema: t.schema,
      availability: this.availability(t, ctx),
    }));
  }

  validateParams(name, params) {
    const tool = this.get(name);
    if (!tool) throw new SchemaError(`unknown tool '${name}'`);
    return validate(tool.schema, params || {});
  }

  describe(name, params) {
    const tool = this.get(name);
    if (tool && typeof tool.describe === "function") {
      try { return tool.describe(params); } catch { /* fall through */ }
    }
    return tool ? tool.title || tool.name : name;
  }

  redactParams(name, params) {
    const tool = this.get(name);
    if (!tool) return params;
    try { return tool.redact(params); } catch { return "[redaction failed]"; }
  }

  // Runs with a hard timeout and an AbortSignal. Result: { ok, summary, data }.
  async run(name, params, ctx = {}) {
    const tool = this.get(name);
    if (!tool) throw new Error(`unknown tool '${name}'`);
    const avail = this.availability(tool, ctx);
    if (!avail.ok) return { ok: false, summary: avail.reason, data: { unavailable: true } };
    let valid;
    try { valid = validate(tool.schema, params || {}); } catch (e) { e.status = 400; throw e; }
    const controller = new AbortController();
    const outer = ctx.signal;
    const onAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener("abort", onAbort, { once: true });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${Math.round(tool.timeoutMs / 1000)}s`)); }, tool.timeoutMs);
    });
    try {
      let result;
      try {
        result = await Promise.race([tool.run(valid, { ...ctx, signal: controller.signal }), timeout]);
      } catch (e) {
        if (outer?.aborted) return { ok: false, summary: "cancelled", data: { cancelled: true } };
        throw e;
      }
      if (outer?.aborted) return { ok: false, summary: "cancelled", data: { cancelled: true } };
      if (typeof result === "string") return { ok: true, summary: result, data: {} };
      return { ok: result?.ok !== false, summary: result?.summary || "done", data: result?.data || {} };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

function platformLabel(p) {
  return { win32: "Windows", darwin: "macOS", linux: "Linux" }[p] || p;
}

module.exports = { ToolRegistry, SchemaError };
