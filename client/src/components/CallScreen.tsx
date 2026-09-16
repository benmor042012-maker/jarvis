import { useState } from "react";

import { Dialog } from "./Dialog";
import { api } from "../api";
import { describeError } from "../lib/protocol";
import { desktopBridge, useJarvis } from "../state/jarvisStore";

const OUTCOMES: { value: string; label: string }[] = [
  { value: "answered", label: "They answered" },
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "cancelled", label: "I did not call" },
];

/**
 * Nothing is ever dialled without this screen. It shows the exact number, why
 * JARVIS wants to call it, and what will actually happen when you approve —
 * which is never more than opening the phone's dialer with the number filled in.
 */
export function CallScreen() {
  const id = useJarvis((s) => s.callOpen);
  const calls = useJarvis((s) => s.calls);
  const phone = useJarvis((s) => s.phone);
  const openCall = useJarvis((s) => s.openCall);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");
  const call = calls.find((c) => c.id === id) ?? null;
  const onPhone = !desktopBridge();

  if (!call) return null;

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    void fn()
      .catch((err: unknown) => {
        setError(describeError(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const approve = () => {
    run(async () => {
      const r = await api.decideCall(call.id, "approve", call.hash);
      useJarvis.setState({ calls: [r.call, ...calls.filter((c) => c.id !== call.id)] });
    });
  };

  const reject = () => {
    run(async () => {
      await api.decideCall(call.id, "reject", call.hash);
      openCall(null);
    });
  };

  const openDialer = () => {
    run(async () => {
      // This is the whole mechanism: a tel: link. The operating system opens the
      // dialer with the number ready and you press the call button yourself.
      // A web page cannot press it, and it is never told what happened next.
      window.location.href = `tel:${call.number.replace(/[^\d+]/g, "")}`;
      const r = await api.dialerOpened(call.id);
      useJarvis.setState({ calls: [r.call, ...calls.filter((c) => c.id !== call.id)] });
    });
  };

  const outcome = (value: string) => {
    run(async () => {
      await api.callOutcome(call.id, value, note);
      if (draft.trim()) await api.callDraft(call.id, draft.trim());
      openCall(null);
    });
  };

  const waiting = call.status === "pending_approval";
  const canDial = phone?.capabilities.open_dialer_on_phone.available ?? false;

  return (
    <Dialog title={waiting ? "Approve this call" : "Call"} onClose={() => { openCall(null); }} wide>
      {call.simulation && (
        <div className="banner banner-warn">
          <strong>SIMULATION — no real call will be placed.</strong>
          <p>{call.simulation_because}</p>
        </div>
      )}

      <dl className="kv">
        <dt>Number</dt>
        <dd className="call-number">{call.number}</dd>
        <dt>Reason</dt>
        <dd>{call.reason || "—"}</dd>
        <dt>Requested by</dt>
        <dd>{call.requested_by}</dd>
        <dt>Status</dt>
        <dd>{call.status.replace(/_/g, " ")}</dd>
        {call.approved_by && (
          <>
            <dt>Approved by</dt>
            <dd>{call.approved_by} at {new Date(call.approved_at ?? 0).toLocaleTimeString()}</dd>
          </>
        )}
        {call.outcome && (
          <>
            <dt>Outcome</dt>
            <dd>{call.outcome.replace(/_/g, " ")} — {call.outcome_note}</dd>
          </>
        )}
      </dl>

      <p className="help">
        What approving does: {call.simulation ? "nothing is dialled — the whole flow runs so you can see it, and every screen says SIMULATION." : "JARVIS sends the number to the paired phone over your Wi-Fi. The phone opens its dialer with the number filled in, and you press call. JARVIS never places or answers a call by itself, and it is never told whether the call connected."}
      </p>

      {waiting ? (
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={reject} disabled={busy}>
            Reject
          </button>
          <button type="button" className="btn btn-primary" onClick={approve} disabled={busy}>
            {call.simulation ? "Approve (simulated)" : "Approve"}
          </button>
        </div>
      ) : call.status === "approved" ? (
        <div className="dialog-actions">
          {onPhone && canDial ? (
            <button type="button" className="btn btn-primary" onClick={openDialer} disabled={busy}>
              Open the dialer for {call.number}
            </button>
          ) : (
            <p className="help">
              {canDial
                ? "Approved. Open this on the paired phone (same Wi-Fi, JARVIS page open) and press “Open the dialer” there — this computer has no way to place a cellular call."
                : phone?.capabilities.open_dialer_on_phone.blocked_because ?? "No phone is connected, so the dialer cannot be opened."}
            </p>
          )}
          <button type="button" className="btn btn-danger" onClick={() => { run(async () => { await api.stopCall(call.id); openCall(null); }); }} disabled={busy}>
            Stop
          </button>
        </div>
      ) : null}

      {(call.status === "dialer_opened" || call.status === "simulated") && (
        <section className="call-after">
          <h3>What actually happened?</h3>
          <p className="help">JARVIS cannot see this. Android does not tell a web page whether a call was placed, answered or refused, so it records only what you tell it.</p>
          <label className="field">
            <span>Note (text only — no call audio is ever recorded)</span>
            <input value={note} onChange={(e) => { setNote(e.target.value); }} maxLength={1000} placeholder="e.g. asked for an update, wants a quote by Sunday" />
          </label>
          <label className="field">
            <span>Draft reply to write up later — DRAFT ONLY, NOTHING IS SENT</span>
            <textarea value={draft} onChange={(e) => { setDraft(e.target.value); }} rows={3} maxLength={4000} />
          </label>
          <div className="dialog-actions">
            {OUTCOMES.map((o) => (
              <button key={o.value} type="button" className="btn btn-ghost" onClick={() => { outcome(o.value); }} disabled={busy}>
                {o.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {call.transcript.length > 0 && (
        <ul className="list">
          {call.transcript.map((t, i) => (
            <li key={i}>
              <strong>{t.speaker === "me" ? "me" : "them"}:</strong> {t.text}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <p className="help">No WhatsApp, Telegram, SMS or email is involved, and no telephony or VoIP provider is used. Approving only ever opens a dialer on your own phone.</p>
    </Dialog>
  );
}
