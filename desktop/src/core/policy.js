// Permission policy. Decides, for one tool call, whether it runs, asks, or is
// refused — from the mode, the tool's risk, the per-tool policy and any task
// scope approval. Never weakened for demos: high risk always asks.
const RISK_ORDER = { low: 0, medium: 1, high: 2 };

// decision: "allow" | "ask" | "deny"
function decide({ tool, mode, toolPolicies = {}, taskApproved = new Set(), emergency = false, planId = null }) {
  if (emergency) return { decision: "deny", reason: "emergency_stopped", risk: tool.risk };
  const policy = toolPolicies[tool.name];
  if (policy === "blocked") return { decision: "deny", reason: "blocked_by_policy", risk: tool.risk };
  if (tool.risk === "blocked") return { decision: "deny", reason: "blocked", risk: tool.risk };

  if (mode === "safe") {
    if (tool.risk === "low" && tool.reversible !== false) return { decision: "allow", reason: "safe_mode_readonly", risk: tool.risk };
    return { decision: "deny", reason: "safe_mode", risk: tool.risk };
  }

  // High risk always needs an explicit confirmation, in every mode.
  if (tool.risk === "high") {
    return { decision: "ask", reason: "high_risk", risk: tool.risk, secondConfirmation: true };
  }

  if (mode === "advanced" && policy) {
    if (policy === "allowed") return { decision: "allow", reason: "policy_allowed", risk: tool.risk };
    if (policy === "allowed_for_task") {
      if (planId && taskApproved.has(`${planId}:${tool.name}`)) return { decision: "allow", reason: "task_approved", risk: tool.risk };
      return { decision: "ask", reason: "policy_ask_task", risk: tool.risk, taskApprovable: true };
    }
    if (policy === "ask_every_time") return { decision: "ask", reason: "policy_ask", risk: tool.risk };
  }

  if (tool.risk === "low") return { decision: "allow", reason: "low_risk", risk: tool.risk };
  // medium
  if (planId && taskApproved.has(`${planId}:${tool.name}`)) return { decision: "allow", reason: "task_approved", risk: tool.risk };
  return { decision: "ask", reason: "medium_risk", risk: tool.risk, taskApprovable: true };
}

function highestRisk(risks) {
  return risks.reduce((acc, r) => (RISK_ORDER[r] > RISK_ORDER[acc] ? r : acc), "low");
}

module.exports = { decide, highestRisk, RISK_ORDER };
