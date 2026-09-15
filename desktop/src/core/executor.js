// Plans, approvals and jobs.
//
// 1. plan()      command -> Plan (actions + per-action policy decision, hash)
// 2. approve()   binds an approval to plan_id + actions_hash (+ scope)
// 3. execute()   runs the plan as a cancellable Job with per-action timeouts
// 4. audit       every step is logged (redacted) and streamed as events
//
// Job status: completed | partial | failed | cancelled | denied | expired | offline
const EventEmitter = require("events");
const { paramsHash, uuid, nowMs, redact } = require("./util");
const { decide, highestRisk } = require("./policy");
const audit = require("./audit");
const { planCommand } = require("./planner");

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS = 200;
const MAX_JOBS = 200;

class Executor extends EventEmitter {
  constructor({ registry, state, getConfig, host = {} }) {
    super();
    this.registry = registry;
    this.state = state;
    this.getConfig = getConfig;
    this.host = host; // { confirmLocal(plan, action) -> Promise<boolean>, browser, notify }
    this.plans = new Map();
    this.jobs = new Map();
    this.taskApprovals = new Set(); // `${planId}:${tool}`
  }

  _emit(type, payload) {
    this.emit("event", { type, at: nowMs(), ...payload });
  }

  // --- planning ------------------------------------------------------------
  async plan(command, { device, session, signal, forceMock } = {}) {
    const cfg = this.getConfig();
    if (this.state.emergency) {
      return this._storePlan({ command, message: "Emergency stop is active. Clear it before planning anything.", actions: [], provider: "none", mock: true, device, session, denied: "emergency_stopped" });
    }
    const raw = await planCommand(command, { cfg, registry: this.registry, signal, forceMock });
    return this._storePlan({ command, ...raw, device, session });
  }

  _storePlan({ command, message, actions = [], provider, model = null, mock, notes = [], suggest = null, device, session, denied = null, unknown = false }) {
    const cfg = this.getConfig();
    const planId = uuid();
    const decorated = actions.map((a, i) => {
      const tool = this.registry.get(a.tool);
      const avail = this.registry.availability(tool, { cfg });
      const d = decide({ tool, mode: cfg.mode, toolPolicies: cfg.toolPolicies, taskApproved: this.taskApprovals, emergency: this.state.emergency, planId });
      return {
        index: i,
        tool: a.tool,
        title: tool.title || tool.name,
        description: this.registry.describe(a.tool, a.params),
        params: a.params,
        params_redacted: this.registry.redactParams(a.tool, a.params),
        risk: tool.risk,
        reversible: !!tool.reversible,
        timeout_ms: tool.timeoutMs,
        available: avail.ok,
        unavailable_reason: avail.ok ? null : avail.reason,
        decision: avail.ok ? d.decision : "deny",
        reason: avail.ok ? d.reason : "unavailable",
        second_confirmation: !!d.secondConfirmation,
        task_approvable: !!d.taskApprovable,
      };
    });
    const actionsHash = paramsHash(decorated.map((a) => ({ tool: a.tool, params: a.params })));
    const plan = {
      plan_id: planId,
      created_at: nowMs(),
      expires_at: nowMs() + PLAN_TTL_MS,
      command,
      message,
      provider,
      model,
      mock: !!mock,
      notes,
      suggest,
      unknown,
      actions: decorated,
      actions_hash: actionsHash,
      highest_risk: highestRisk(decorated.map((a) => a.risk)),
      requires_approval: decorated.some((a) => a.decision === "ask"),
      denied: denied || (decorated.length && decorated.every((a) => a.decision === "deny") ? decorated[0].reason : null),
      status: "pending",
      device_id: device?.id || null,
      device_name: device?.name || null,
      session: session || null,
      approval: null,
      job_id: null,
    };
    this.plans.set(planId, plan);
    if (this.plans.size > MAX_PLANS) {
      for (const [id, p] of this.plans) { if (this.plans.size <= MAX_PLANS / 2) break; if (p.status !== "executing") this.plans.delete(id); }
    }
    audit.log({ event: "plan_created", plan_id: planId, device: device?.name, detail: { command: command.slice(0, 200), provider, actions: decorated.map((a) => ({ tool: a.tool, risk: a.risk, decision: a.decision })) } });
    this._emit("plan", { plan: this.publicPlan(plan) });
    return plan;
  }

  publicPlan(plan) {
    const { actions, ...rest } = plan;
    return { ...rest, actions: actions.map(({ params, ...a }) => ({ ...a, params: this._paramsForDisplay(a.tool, params) })) };
  }

  // Parameters shown in the approval UI: full text for things the user must
  // read (scripts, typed text, file contents), always local, never logged.
  _paramsForDisplay(tool, params) {
    return redact(params);
  }

  getPlan(id) {
    const p = this.plans.get(id);
    if (!p) return null;
    if (p.status === "pending" && nowMs() > p.expires_at) { p.status = "expired"; }
    return p;
  }

  // --- approval ------------------------------------------------------------
  // decision: "approve" | "reject"; scope: "once" | "task"
  async approve(planId, { actions_hash, decision, scope = "once", device }) {
    const plan = this.getPlan(planId);
    if (!plan) return { ok: false, reason: "unknown_plan", status: 404 };
    if (plan.status === "expired") return { ok: false, reason: "expired", status: 410 };
    if (plan.status !== "pending") return { ok: false, reason: `plan_${plan.status}`, status: 409 };
    if (actions_hash !== plan.actions_hash) {
      audit.log({ event: "approval_rejected", plan_id: planId, device: device?.name, status: "modified" });
      return { ok: false, reason: "modified", status: 400, detail: "The approval does not match the plan that was shown." };
    }
    if (decision !== "approve") {
      plan.status = "rejected";
      plan.approval = { decision: "reject", device_id: device?.id, device_name: device?.name, at: nowMs() };
      audit.log({ event: "plan_rejected", plan_id: planId, device: device?.name });
      this._emit("plan", { plan: this.publicPlan(plan) });
      return { ok: true, plan: this.publicPlan(plan) };
    }
    if (this.state.emergency) return { ok: false, reason: "emergency_stopped", status: 423 };

    // Second local confirmation: high-risk actions approved from a remote
    // device must also be confirmed on the computer itself.
    const needsLocal = plan.actions.some((a) => a.decision === "ask" && a.second_confirmation);
    if (needsLocal && device?.role !== "owner") {
      if (typeof this.host.confirmLocal !== "function") {
        return { ok: false, reason: "local_confirmation_unavailable", status: 423, detail: "High-risk actions need a confirmation on the computer, and the JARVIS window is not running there." };
      }
      plan.status = "awaiting_local";
      this._emit("plan", { plan: this.publicPlan(plan) });
      let confirmed = false;
      try { confirmed = await this.host.confirmLocal(this.publicPlan(plan), device); } catch { confirmed = false; }
      if (!confirmed) {
        plan.status = "rejected";
        plan.approval = { decision: "reject", reason: "local_confirmation_denied", device_id: device?.id, at: nowMs() };
        audit.log({ event: "local_confirmation_denied", plan_id: planId, device: device?.name });
        this._emit("plan", { plan: this.publicPlan(plan) });
        return { ok: false, reason: "local_confirmation_denied", status: 403 };
      }
      audit.log({ event: "local_confirmation_granted", plan_id: planId, device: device?.name });
    }

    plan.status = "approved";
    plan.approval = { decision: "approve", scope, device_id: device?.id, device_name: device?.name, role: device?.role, at: nowMs(), actions_hash };
    if (scope === "task") for (const a of plan.actions) if (a.task_approvable) this.taskApprovals.add(`${planId}:${a.tool}`);
    audit.log({ event: "plan_approved", plan_id: planId, device: device?.name, detail: { scope } });
    return { ok: true, plan: this.publicPlan(plan) };
  }

  // --- execution -----------------------------------------------------------
  execute(planId, { device } = {}) {
    const plan = this.getPlan(planId);
    if (!plan) return { ok: false, reason: "unknown_plan", status: 404 };
    if (plan.status === "expired") return { ok: false, reason: "expired", status: 410 };
    if (plan.status === "executing" || plan.job_id) return { ok: false, reason: "already_running", status: 409 };
    if (this.state.emergency) return { ok: false, reason: "emergency_stopped", status: 423 };
    if (plan.requires_approval && plan.status !== "approved") return { ok: false, reason: "approval_required", status: 409 };
    if (plan.status === "rejected") return { ok: false, reason: "rejected", status: 409 };
    if (!plan.actions.length) return { ok: false, reason: "nothing_to_run", status: 400 };

    const job = {
      job_id: uuid(),
      plan_id: planId,
      status: "queued",
      results: [],
      total: plan.actions.length,
      completed: 0,
      current: null,
      started_at: nowMs(),
      finished_at: null,
      device_id: device?.id || plan.device_id,
      controller: new AbortController(),
    };
    this.jobs.set(job.job_id, job);
    if (this.jobs.size > MAX_JOBS) for (const [id, j] of this.jobs) { if (this.jobs.size <= MAX_JOBS / 2) break; if (j.status !== "running") this.jobs.delete(id); }
    plan.status = "executing";
    plan.job_id = job.job_id;
    this._run(plan, job).catch((e) => { job.status = "failed"; job.error = e.message; });
    return { ok: true, job: this.publicJob(job) };
  }

  async _run(plan, job) {
    const cfg = this.getConfig();
    job.status = "running";
    this.state.beginBusy();
    this._emit("job", { job: this.publicJob(job) });
    let denied = false;
    try {
      for (const action of plan.actions) {
        if (job.controller.signal.aborted || this.state.emergency) { job.status = "cancelled"; break; }
        const decision = action.decision === "ask" && plan.status === "executing" && plan.approval?.decision === "approve" ? "allow" : action.decision;
        job.current = { tool: action.tool, description: action.description, risk: action.risk };
        this._emit("job", { job: this.publicJob(job) });
        if (decision !== "allow") {
          const summary = action.unavailable_reason || reasonText(action.reason);
          job.results.push({ index: action.index, tool: action.tool, status: "denied", ok: false, summary, data: {} });
          audit.log({ event: "action_denied", tool: action.tool, risk: action.risk, plan_id: plan.plan_id, params: action.params_redacted, status: action.reason });
          denied = true;
          job.completed++;
          continue;
        }
        const started = nowMs();
        let res;
        try {
          res = await this.registry.run(action.tool, action.params, { cfg, signal: job.controller.signal, host: this.host, plan, emit: (p) => this._emit("progress", { job_id: job.job_id, ...p }) });
        } catch (e) {
          const msg = String(e.message || e);
          res = { ok: false, summary: /timed out/.test(msg) ? msg : `${action.tool} failed: ${msg}`, data: { error: msg, timed_out: /timed out/.test(msg) } };
        }
        const status = job.controller.signal.aborted ? "cancelled" : res.data?.timed_out ? "timeout" : res.ok ? "completed" : "failed";
        job.results.push({ index: action.index, tool: action.tool, status, ok: !!res.ok, summary: res.summary, data: res.data || {}, ms: nowMs() - started });
        audit.log({ event: "action_" + status, tool: action.tool, risk: action.risk, plan_id: plan.plan_id, device: plan.approval?.device_name || plan.device_name, params: action.params_redacted, status, detail: { summary: String(res.summary).slice(0, 300), ms: nowMs() - started } });
        job.completed++;
        this._emit("job", { job: this.publicJob(job) });
        if (status === "cancelled") { job.status = "cancelled"; break; }
      }
    } finally {
      this.state.endBusy();
    }
    if (job.status !== "cancelled") {
      const okCount = job.results.filter((r) => r.ok).length;
      if (okCount === job.results.length && job.results.length === job.total) job.status = "completed";
      else if (okCount === 0) job.status = denied && job.results.every((r) => r.status === "denied") ? "denied" : "failed";
      else job.status = "partial";
    }
    job.current = null;
    job.finished_at = nowMs();
    plan.status = "done";
    for (const key of [...this.taskApprovals]) if (key.startsWith(plan.plan_id + ":")) this.taskApprovals.delete(key);
    audit.log({ event: "job_finished", plan_id: plan.plan_id, status: job.status, detail: { completed: job.completed, total: job.total } });
    this._emit("job", { job: this.publicJob(job) });
    this._emit("plan", { plan: this.publicPlan(plan) });
  }

  publicJob(job) {
    const { controller, ...rest } = job;
    return rest;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  cancel(jobId, { device } = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === "queued" || job.status === "running") {
      job.controller.abort();
      if (job.status === "queued") job.status = "cancelled";
      audit.log({ event: "job_cancel_requested", plan_id: job.plan_id, device: device?.name });
    }
    return this.publicJob(job);
  }

  cancelAll() {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === "running" || job.status === "queued") { job.controller.abort(); n++; }
    for (const plan of this.plans.values()) if (plan.status === "pending" || plan.status === "awaiting_local") plan.status = "rejected";
    this.taskApprovals.clear();
    return n;
  }

  pendingPlans() {
    return [...this.plans.values()].filter((p) => (p.status === "pending" || p.status === "awaiting_local") && nowMs() < p.expires_at && p.actions.length).map((p) => this.publicPlan(p));
  }
}

function reasonText(reason) {
  return {
    emergency_stopped: "Emergency stop is active.",
    blocked_by_policy: "Blocked by your tool policy.",
    blocked: "This action is permanently blocked.",
    safe_mode: "Safe Mode allows only read-only, reversible actions.",
    unavailable: "This tool is not available on this computer.",
  }[reason] || `Denied (${reason}).`;
}

module.exports = { Executor, PLAN_TTL_MS };
