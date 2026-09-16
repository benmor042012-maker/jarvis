import { useEffect, useState } from "react";

import { Dialog } from "./Dialog";
import { api } from "../api";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { speakAlert, useJarvis } from "../state/jarvisStore";
import type { Customer } from "../types";

const SNOOZE = [
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Tomorrow", minutes: 60 * 16 },
];

/** The alert screen: who needs attention, why, and what you can do about it. */
export function AlertScreen() {
  const alertId = useJarvis((s) => s.alertOpen);
  const alerts = useJarvis((s) => s.alerts);
  const label = useJarvis((s) => s.alertLabel);
  const connection = useJarvis((s) => s.connection);
  const openAlert = useJarvis((s) => s.openAlert);
  const openCall = useJarvis((s) => s.openCall);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alert = alerts.find((a) => a.id === alertId) ?? null;

  const [act, actState] = useAction(async (what: "acknowledge" | "resolve" | "retry" | "snooze", minutes?: number) => {
    if (!alert) return;
    if (what === "acknowledge") await api.acknowledgeAlert(alert.id);
    else if (what === "resolve") await api.resolveAlert(alert.id);
    else if (what === "retry") await api.retryAlert(alert.id);
    else await api.snoozeAlert(alert.id, minutes ?? 15);
    await useJarvis.getState().refreshAlerts();
    if (what !== "retry") openAlert(null);
  });

  useEffect(() => {
    if (!alert || !details) return;
    let cancelled = false;
    void api
      .customers()
      .then((r) => {
        if (!cancelled) setCustomer(r.customers.find((c) => c.id === alert.customer_id) ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [alert, details]);

  if (!alert) return null;

  const call = async () => {
    setError(null);
    if (!customer?.phone) {
      setError("This customer has no phone number saved, so there is nothing to dial. Add one in the Alerts panel.");
      setDetails(true);
      return;
    }
    try {
      const r = await api.requestCall({ to: customer.phone, reason: `${alert.customer_name}: ${alert.headline}`, customer_id: alert.customer_id });
      openCall(r.call.id);
      openAlert(null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <Dialog title="Customer needs attention" onClose={() => { openAlert(null); }} wide>
      <div className="alert-head">
        <span className="risk" data-risk={alert.score >= 80 ? "high" : "medium"}>
          urgency {alert.score}
        </span>
        <h3>{alert.customer_name}</h3>
      </div>
      <p className="alert-why">{alert.headline}</p>
      <ul className="list">
        {alert.signals.map((sig, i) => (
          <li key={i}>{sig.why}</li>
        ))}
      </ul>

      <dl className="kv">
        <dt>Raised</dt>
        <dd>{new Date(alert.created_at).toLocaleString()}</dd>
        <dt>Status</dt>
        <dd>{alert.status}{alert.status === "snoozed" && alert.snooze_until ? ` until ${new Date(alert.snooze_until).toLocaleTimeString()}` : ""}</dd>
        <dt>Attempts</dt>
        <dd>{alert.attempts}</dd>
        <dt>Delivered</dt>
        <dd>
          {[alert.delivered.window && "this screen", alert.delivered.notification && "Windows notification", alert.delivered.sound && "sound", alert.delivered.speech && "spoken", alert.delivered.phone > 0 && `${String(alert.delivered.phone)} paired phone(s) on your Wi-Fi`].filter(Boolean).join(", ") || "on this screen only"}
        </dd>
        {alert.quiet_hours && (
          <>
            <dt>Quiet hours</dt>
            <dd>Sound, speech and notifications were suppressed. The alert itself was not.</dd>
          </>
        )}
      </dl>

      <p className="pill pill-model">{label}</p>

      <details
        open={details}
        onToggle={(e) => {
          setDetails((e.target as HTMLDetailsElement).open);
        }}
      >
        <summary>Customer details (never read out loud)</summary>
        {customer ? (
          <dl className="kv">
            <dt>Contact</dt>
            <dd>{customer.contact || "—"}</dd>
            <dt>Phone</dt>
            <dd>{customer.phone || "—"}</dd>
            <dt>Subject</dt>
            <dd>{customer.subject || "—"}</dd>
            <dt>Last message</dt>
            <dd>{customer.lastMessage || "—"}</dd>
            <dt>Deadline</dt>
            <dd>{customer.deadline || "—"}</dd>
            <dt>Note</dt>
            <dd>{customer.note || "—"}</dd>
          </dl>
        ) : (
          <p className="help">Loading the local record…</p>
        )}
      </details>

      {(error ?? actState.error) && (
        <p className="error-text" role="alert">
          {error ?? actState.error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={() => void act("acknowledge")} disabled={actState.phase === "loading" || connection !== "online"}>
          Acknowledge
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void act("resolve")} disabled={actState.phase === "loading" || connection !== "online"}>
          Resolve
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void act("retry")} disabled={actState.phase === "loading" || connection !== "online"} title="Alert me again now">
          Alert again
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void speakAlert(alert)} title="Read the name out loud">
          Say it
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void call()} disabled={connection !== "online"}>
          Call this customer…
        </button>
      </div>
      <div className="dialog-actions">
        <span className="help">Snooze:</span>
        {SNOOZE.map((s) => (
          <button key={s.minutes} type="button" className="btn btn-ghost" onClick={() => void act("snooze", s.minutes)} disabled={actState.phase === "loading" || connection !== "online"}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="help">Nothing was sent to this customer. JARVIS does not send messages — it only tells you.</p>
    </Dialog>
  );
}
