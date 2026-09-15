import { useEffect, useRef } from "react";

import { describeAction, useJarvis } from "../state/jarvisStore";
import type { Action } from "../types";

function payloadText(a: Action): string {
  switch (a.type) {
    case "open_url":
      return a.payload.url;
    case "open_app":
      return `app: ${a.payload.app}`;
    case "search_files":
      return `query: ${a.payload.query}`;
    case "read_text_file":
      return `path: ${a.payload.path}`;
    case "create_text_file":
      return `path: ${a.payload.path}\n${a.payload.content.slice(0, 400)}${a.payload.content.length > 400 ? "…" : ""}`;
  }
}

export function PermissionDialog() {
  const plan = useJarvis((s) => s.pendingPlan);
  const confirmPlan = useJarvis((s) => s.confirmPlan);
  const rejectPlan = useJarvis((s) => s.rejectPlan);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!plan) return;
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        rejectPlan();
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [plan, rejectPlan]);

  if (!plan) return null;
  const highest = plan.actions.some((a) => a.risk === "high") ? "high" : plan.actions.some((a) => a.risk === "medium") ? "medium" : "low";

  return (
    <div className="backdrop" role="presentation">
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="perm-title" aria-describedby="perm-desc">
        <h2 id="perm-title">Confirm actions</h2>
        <p id="perm-desc">
          {plan.message} JARVIS wants to run {plan.actions.length} action{plan.actions.length === 1 ? "" : "s"} ({highest} risk). Nothing runs until you approve.
        </p>
        <ol className="plan-list">
          {plan.actions.map((a, i) => (
            <li key={i} className="plan-item">
              <span className="risk" data-risk={a.risk}>
                {a.risk}
              </span>
              <div>
                <strong>{describeAction(a)}</strong>
                <code>{payloadText(a)}</code>
              </div>
            </li>
          ))}
        </ol>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={rejectPlan}>
            Dismiss
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary" onClick={() => void confirmPlan()}>
            Approve and run
          </button>
        </div>
      </div>
    </div>
  );
}
