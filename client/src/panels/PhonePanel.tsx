import { useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";

const TITLES: Record<string, string> = {
  place_call_from_computer: "Place a call from this computer",
  open_dialer_on_phone: "Open the dialer on a paired phone",
  auto_dial_without_pressing: "Press the call button for you",
  answer_incoming_call: "Answer an incoming call",
  answer_from_computer_over_bluetooth: "Answer from the computer over Bluetooth",
  record_call_audio: "Record call audio",
};

export function PhonePanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const phone = useJarvis((s) => s.phone);
  const calls = useJarvis((s) => s.calls);
  const refreshPhone = useJarvis((s) => s.refreshPhone);
  const openCall = useJarvis((s) => s.openCall);
  const connection = useJarvis((s) => s.connection);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshPhone().catch(() => undefined);
  }, [refreshPhone]);

  const [request, requestState] = useAction(async (simulate: boolean) => {
    setError(null);
    try {
      const r = await api.requestCall({ to: number, reason, simulate });
      openCall(r.call.id);
      setNumber("");
      setReason("");
    } catch (err) {
      setError(describeError(err));
      throw err;
    }
  });

  return (
    <Dialog title="Phone" onClose={() => { setPanel(null); }} wide>
      <p>{phone?.summary}</p>

      <h3>What is actually possible</h3>
      <ul className="list">
        {Object.entries(phone?.capabilities ?? {}).map(([key, cap]) => (
          <li key={key} className="list-item">
            <div>
              <strong>
                {cap.available ? "✔" : "✘"} {TITLES[key] ?? key}
              </strong>
              <div className="log-meta">{cap.why}</div>
              {cap.requires && <div className="log-meta">Requires: {cap.requires}</div>}
              {cap.blocked_because && <div className="log-meta">Blocked: {cap.blocked_because}</div>}
              {cap.one_time_step && <div className="log-meta">One-time step: {cap.one_time_step}</div>}
            </div>
          </li>
        ))}
      </ul>

      <h3>Paired phones on your Wi-Fi</h3>
      <ul className="list">
        {(phone?.phones.length ?? 0) === 0 && <li className="help">None. Pair a phone from the Devices panel and keep the JARVIS page open on it.</li>}
        {phone?.phones.map((p) => (
          <li key={p.id}>
            {p.name} — {p.online ? "connected" : `last seen ${p.last_seen ? new Date(p.last_seen).toLocaleString() : "never"}`}
          </li>
        ))}
      </ul>

      <h3>Ask to call a number</h3>
      <div className="settings-grid">
        <label className="field">
          <span>Number</span>
          <input value={number} onChange={(e) => { setNumber(e.target.value); }} placeholder="050-000-0000" inputMode="tel" />
        </label>
        <label className="field">
          <span>Reason (shown on the approval screen)</span>
          <input value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={400} />
        </label>
        <div className="dialog-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={() => void request(true)} disabled={!number.trim() || connection !== "online" || requestState.phase === "loading"}>
            Simulate a call
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void request(false)} disabled={!number.trim() || connection !== "online" || requestState.phase === "loading"}>
            Request approval to call
          </button>
        </div>
      </div>

      <h3>Call history</h3>
      <ul className="list">
        {calls.length === 0 && <li className="help">No calls have been requested.</li>}
        {calls.map((c) => (
          <li key={c.id} className="list-item">
            <div>
              <strong>{c.number_masked}</strong>
              <div className="log-meta">
                {new Date(c.created_at).toLocaleString()} · {c.status.replace(/_/g, " ")}
                {c.simulation ? " · SIMULATION" : ""}
                {c.outcome ? ` · ${c.outcome.replace(/_/g, " ")}` : ""}
              </div>
              {c.reason && <div className="log-meta">{c.reason}</div>}
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => { openCall(c.id); }}>
              Open
            </button>
          </li>
        ))}
      </ul>

      {(error ?? requestState.error) && (
        <p className="error-text" role="alert">
          {error ?? requestState.error}
        </p>
      )}
      <p className="help">
        JARVIS never places or answers a call by itself and never claims one connected. The most it can do is hand your own phone a number so its dialer opens with the number ready — you press call. No telephony provider, VoIP service, WhatsApp, Telegram, SMS or email is involved, and call audio is never recorded.
      </p>
    </Dialog>
  );
}
