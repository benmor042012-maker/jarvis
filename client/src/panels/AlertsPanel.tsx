import { useEffect, useState } from "react";

import { api } from "../api";
import { DeviceAlerts } from "../components/DeviceAlerts";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { Customer, CustomerAlert } from "../types";

const EMPTY: Partial<Customer> = { name: "", contact: "", phone: "", subject: "", lastMessage: "", note: "", deadline: "", waitingSince: "", priority: "normal", answered: false };

export function AlertsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const alerts = useJarvis((s) => s.alerts);
  const label = useJarvis((s) => s.alertLabel);
  const refreshAlerts = useJarvis((s) => s.refreshAlerts);
  const openAlert = useJarvis((s) => s.openAlert);
  const connection = useJarvis((s) => s.connection);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [history, setHistory] = useState<CustomerAlert[]>([]);
  const [form, setForm] = useState<Partial<Customer>>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [c, h] = await Promise.all([api.customers(), api.alertHistory(50)]);
      setCustomers(c.customers);
      setHistory(h.alerts);
      await refreshAlerts();
    } catch (err) {
      setError(describeError(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [save, saveState] = useAction(async () => {
    setError(null);
    await api.saveCustomer(form);
    setForm(EMPTY);
    await load();
  });

  const [scan, scanState] = useAction(async () => {
    const r = await api.scanAlerts();
    await load();
    if (r.raised.length === 0) useJarvis.getState().addLog("system", `Checked ${String(r.scanned)} customer record(s). Nothing is urgent right now.`);
  });

  return (
    <Dialog title="Customer alerts" onClose={() => { setPanel(null); }} wide>
      <p className="pill pill-model">{label}</p>
      <div className="grid-2">
        <section>
          <h3>Open alerts</h3>
          <ul className="list">
            {alerts.filter((a) => a.status !== "resolved").length === 0 && <li className="help">Nothing needs you right now.</li>}
            {alerts
              .filter((a) => a.status !== "resolved")
              .map((a) => (
                <li key={a.id} className="list-item">
                  <div>
                    <strong>{a.customer_name}</strong>
                    <div className="log-meta">
                      {a.headline} · {a.status}
                      {a.status === "snoozed" && a.snooze_until ? ` until ${new Date(a.snooze_until).toLocaleTimeString()}` : ""}
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={() => { openAlert(a.id); }}>
                    Open
                  </button>
                </li>
              ))}
          </ul>
          <button type="button" className="btn btn-ghost" onClick={() => void scan()} disabled={scanState.phase === "loading" || connection !== "online"}>
            {scanState.phase === "loading" ? "Checking…" : "Check now"}
          </button>

          <h3>Recent</h3>
          <ul className="list">
            {history.length === 0 && <li className="help">No alerts yet.</li>}
            {history.map((a) => (
              <li key={a.id}>
                <span className="log-meta">{new Date(a.created_at).toLocaleString()} · {a.status}</span>
                <div>
                  {a.customer_name} — {a.headline}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>Customers on this computer</h3>
          <ul className="list">
            {customers.length === 0 && <li className="help">No customer records yet. Add one below.</li>}
            {customers.map((c) => (
              <li key={c.id} className="list-item">
                <div>
                  <strong>{c.name}</strong>
                  <div className="log-meta">
                    urgency {c.score}
                    {c.priority === "high" ? " · marked priority" : ""}
                    {c.phone ? ` · ${c.phone}` : ""}
                    {c.signals.length ? ` · ${c.signals.map((s) => s.why).join("; ")}` : ""}
                  </div>
                </div>
                <div className="row">
                  <button type="button" className="btn btn-ghost" onClick={() => { setForm(c); }}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void api.raiseAlert(c.id).then(load).catch((err: unknown) => { setError(describeError(err)); })}
                    title="Mark as needing attention right now"
                  >
                    Alert me
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => void api.deleteCustomer(c.id).then(load).catch((err: unknown) => { setError(describeError(err)); })}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h3>{form.id ? "Edit customer" : "Add a customer"}</h3>
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input value={form.name ?? ""} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} required maxLength={120} />
            </label>
            <label className="field">
              <span>Phone (used only if you approve a call)</span>
              <input value={form.phone ?? ""} onChange={(e) => { setForm({ ...form, phone: e.target.value }); }} maxLength={40} />
            </label>
            <label className="field">
              <span>Contact (email or other)</span>
              <input value={form.contact ?? ""} onChange={(e) => { setForm({ ...form, contact: e.target.value }); }} maxLength={200} />
            </label>
            <label className="field">
              <span>Subject</span>
              <input value={form.subject ?? ""} onChange={(e) => { setForm({ ...form, subject: e.target.value }); }} maxLength={300} />
            </label>
            <label className="field span-2">
              <span>Their last message (this is what the urgency rules read)</span>
              <textarea rows={2} value={form.lastMessage ?? ""} onChange={(e) => { setForm({ ...form, lastMessage: e.target.value }); }} maxLength={4000} />
            </label>
            <label className="field span-2">
              <span>Note</span>
              <textarea rows={2} value={form.note ?? ""} onChange={(e) => { setForm({ ...form, note: e.target.value }); }} maxLength={4000} />
            </label>
            <label className="field">
              <span>Deadline</span>
              <input type="datetime-local" value={form.deadline ?? ""} onChange={(e) => { setForm({ ...form, deadline: e.target.value }); }} />
            </label>
            <label className="field">
              <span>Waiting for an answer since</span>
              <input type="datetime-local" value={form.waitingSince ?? ""} onChange={(e) => { setForm({ ...form, waitingSince: e.target.value }); }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.priority === "high"} onChange={(e) => { setForm({ ...form, priority: e.target.checked ? "high" : "normal" }); }} />
              Mark as a priority customer
            </label>
            <label className="check">
              <input type="checkbox" checked={form.answered ?? false} onChange={(e) => { setForm({ ...form, answered: e.target.checked }); }} />
              I already answered them
            </label>
            <div className="dialog-actions span-2">
              {form.id && (
                <button type="button" className="btn btn-ghost" onClick={() => { setForm(EMPTY); }}>
                  New customer
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={saveState.phase === "loading" || !(form.name ?? "").trim() || connection !== "online"}>
                {saveState.phase === "loading" ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </section>
      </div>
      <DeviceAlerts />
      {(error ?? saveState.error ?? scanState.error) && (
        <p className="error-text" role="alert">
          {error ?? saveState.error ?? scanState.error}
        </p>
      )}
      <p className="help">These records stay in a file on this computer. Urgency is decided by fixed rules — keywords, deadlines, how long someone has waited, and what you marked — so it keeps working with no AI model installed and in offline mode.</p>
    </Dialog>
  );
}
