import { useEffect, useRef, useState } from "react";

import { useJarvis } from "../state/jarvisStore";
import type { PlanAction } from "../types";
import { Dialog } from "./Dialog";

function paramLines(a: PlanAction): string {
  const entries = Object.entries(a.params);
  if (!entries.length) return "(no parameters)";
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
}

export function ApprovalDialog() {
  const planId = useJarvis((s) => s.approvalOpen);
  const plans = useJarvis((s) => s.pendingPlans);
  const decidePlan = useJarvis((s) => s.decidePlan);
  const openApproval = useJarvis((s) => s.openApproval);
  const role = useJarvis((s) => s.creds?.role);
  const [scope, setScope] = useState<"once" | "task">("once");
  const [working, setWorking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const plan = plans.find((p) => p.plan_id === planId) ?? null;

  useEffect(() => {
    setScope("once");
    setWorking(false);
  }, [planId]);

  if (!plan) return null;
  const asking = plan.actions.filter((a) => a.decision === "ask");
  const denied = plan.actions.filter((a) => a.decision === "deny");
  const taskApprovable = asking.length > 0 && asking.every((a) => a.task_approvable);
  const needsSecond = asking.some((a) => a.second_confirmation);
  const remaining = Math.max(0, Math.round((plan.expires_at - Date.now()) / 1000));

  const decide = (decision: "approve" | "reject") => {
    setWorking(true);
    void decidePlan(plan, decision, scope).finally(() => {
      setWorking(false);
    });
  };

  return (
    <Dialog
      title="Approval required"
      onClose={() => {
        openApproval(null);
      }}
      initialFocus={confirmRef}
      describedBy="approval-desc"
    >
      <p id="approval-desc">
        <strong>{plan.command}</strong>
        <br />
        {plan.message}
      </p>
      <p className="help">
        {plan.device_name ? `Requested by "${plan.device_name}". ` : ""}
        Highest risk: <span className="risk" data-risk={plan.highest_risk}>{plan.highest_risk}</span> · expires in {remaining}s · nothing runs until you approve.
        {needsSecond && role !== "owner" && " This plan also needs a confirmation on the computer itself."}
      </p>
      <ol className="plan-list">
        {plan.actions.map((a) => (
          <li key={a.index} className="plan-item" data-decision={a.decision}>
            <span className="risk" data-risk={a.risk}>
              {a.risk}
            </span>
            <div>
              <strong>{a.description}</strong>
              <code>{paramLines(a)}</code>
              <span className="help">
                {a.tool} · {a.reversible ? "reversible" : "not reversible"} · timeout {Math.round(a.timeout_ms / 1000)}s
                {a.decision === "deny" ? ` · WILL NOT RUN (${a.unavailable_reason ?? a.reason})` : a.decision === "allow" ? " · runs without asking" : " · needs this approval"}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {denied.length > 0 && (
        <p className="help" role="note">
          {denied.length} action(s) will not run and are listed above with the reason.
        </p>
      )}
      {taskApprovable && (
        <label className="check">
          <input
            type="checkbox"
            checked={scope === "task"}
            onChange={(e) => {
              setScope(e.target.checked ? "task" : "once");
            }}
          />
          Approve these tools for the rest of this task (high-risk actions still ask every time)
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => { decide("reject"); }} disabled={working}>
          Reject
        </button>
        <button ref={confirmRef} type="button" className="btn btn-primary" onClick={() => { decide("approve"); }} disabled={working || asking.length === 0}>
          {working ? "Working…" : asking.length === 0 ? "Nothing to approve" : "Approve and run"}
        </button>
      </div>
    </Dialog>
  );
}
