// Connections: the safety switch, the optional Groq brain, and the webhooks
// that hand text to your own automation account. Every figure here comes from
// the agent; the Groq key and the webhook addresses go in and never come back
// out — the window only ever learns whether a key is set and a connection's
// host.
import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { CloudView, WebhookApp } from "../types";

const APP_LABEL: Record<WebhookApp, string> = {
  google_docs: "Google Docs",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  google_calendar: "Google Calendar",
  spotify: "Spotify",
  whatsapp: "WhatsApp",
  other: "Other",
};

export function ConnectionsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [view, setView] = useState<CloudView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [hook, setHook] = useState<{ name: string; app: WebhookApp; url: string }>({ name: "", app: "google_docs", url: "" });
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.cloudStatus());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const [toggleIsolation, isoState] = useAction(async (on: boolean) => {
    await api.updateSettings({ isolation: on });
    await useJarvis.getState().refreshStatus();
    await useJarvis.getState().refreshSettings();
    await load();
  });
  const [saveKey, keyState] = useAction(async () => {
    setView(await api.setGroqKey(key.trim()));
    setKey("");
    setNote("The key is saved on this computer only. It is never shown again.");
  });
  const [removeKey, removeKeyState] = useAction(async () => {
    setView(await api.setGroqKey(null));
    setNote("The Groq key was removed. JARVIS is fully local again.");
  });
  const [testKey, testState] = useAction(async () => {
    const r = await api.testGroq();
    setNote(r.result.ok ? `The key works. Models available: ${r.result.models.slice(0, 8).join(", ")}${r.result.models.length > 8 ? "…" : ""}` : `The key did not work: ${r.result.error ?? "unknown"}`);
  });
  const [addHook, hookState] = useAction(async () => {
    await api.saveWebhook({ name: hook.name, app: hook.app, url: hook.url });
    setHook({ name: "", app: hook.app, url: "" });
    await load();
  });
  const [delHook, delState] = useAction(async (id: string) => {
    await api.deleteWebhook(id);
    await load();
  });
  const [testHook, testHookState] = useAction(async (id: string) => {
    const r = await api.sendWebhook({ id, test: true });
    setNote(`Test sent to ${r.sent.connection} (${r.sent.service}). Check your scenario's history.`);
    await load();
  });

  const busyError = isoState.error ?? keyState.error ?? removeKeyState.error ?? testState.error ?? hookState.error ?? delState.error ?? testHookState.error;
  const g = view?.groq;

  return (
    <Dialog title="Connections" onClose={() => { setPanel(null); }} wide>
      {error && <p role="alert" className="error-text">{error}</p>}
      {busyError && <p role="alert" className="error-text">{busyError}</p>}
      {note && <p className="banner banner-ok" role="status">{note}</p>}

      <section>
        <h3>Safety — isolation</h3>
        <p className={view?.isolation ? "banner banner-ok" : "banner banner-warn"}>
          {view?.isolation
            ? "Isolation is ON. No brain — local or Groq — can run programs, shells or scripts, or touch your files, keyboard, mouse, screen, clipboard or browser. JARVIS keeps only its own notes, reminders and drafts."
            : "Isolation is OFF. JARVIS can plan actions on this computer (opening programs, files, typing). Every action still goes through the approval rules, and high-risk ones always ask."}
        </p>
        <button type="button" className={view?.isolation ? "btn btn-ghost" : "btn btn-primary"} disabled={!isOwner || !view || isoState.phase === "loading"} onClick={() => void toggleIsolation(!view?.isolation)} title={isOwner ? "" : "Only the JARVIS computer can change this"}>
          {view?.isolation ? "Turn isolation off" : "Turn isolation on"}
        </button>
      </section>

      <section>
        <h3>Brain — Groq (free plan)</h3>
        <p className="help">
          Optional. With a key, JARVIS plans and writes in under a second. What you ask, text you ask it to write, and customer questions go to Groq; files, screenshots,
          audio and secrets never do. The free plan needs no credit card: past the free limit Groq stops answering until it resets, and JARVIS falls back to its rule planner.
          Nothing can be charged. Get a free key at <strong>console.groq.com/keys</strong>.
        </p>
        <dl className="kv">
          <dt>Key</dt>
          <dd data-ok={g?.configured ? "yes" : "no"}>{g ? (g.configured ? `added${g.from_env ? " (from GROQ_API_KEY)" : ""}` : "none — JARVIS is fully local") : "—"}</dd>
          <dt>In use</dt>
          <dd>{g ? (g.usable ? `yes · ${g.model}` : `no — ${g.reason ?? ""}`) : "—"}</dd>
          <dt>Requests since start</dt>
          <dd>{g ? String(g.calls) : "—"}</dd>
          {g?.last_error && (
            <>
              <dt>Last problem</dt>
              <dd>{g.last_error}</dd>
            </>
          )}
        </dl>
        {isOwner && (
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <label className="field">
              <span>{g?.configured ? "Replace the key" : "Groq API key"}</span>
              <input type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); }} placeholder="gsk_…" />
            </label>
            <div className="field-actions">
              <button type="submit" className="btn btn-primary" disabled={!key.trim() || keyState.phase === "loading"}>Save key</button>
              {g?.configured && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={() => void testKey()} disabled={testState.phase === "loading"}>Test key</button>
                  <button type="button" className="btn btn-danger" onClick={() => void removeKey()} disabled={removeKeyState.phase === "loading"}>Remove key</button>
                </>
              )}
            </div>
          </form>
        )}
      </section>

      <section>
        <h3>App connections — webhooks</h3>
        <p className="help">
          Connect Google Docs, Gmail, Sheets, Calendar or Spotify through a free automation account: create a scenario in <strong>Make</strong> (free: 1,000 operations a
          month) that starts with “Custom webhook”, copy its address, and paste it here. JARVIS only <em>sends</em> — nothing on the internet can reach this computer — and
          only when you press Send. For WhatsApp, use “Open in WhatsApp” in the Writing Agent: it is free and you press send yourself.
        </p>
        {view && view.webhooks.length === 0 && <p className="help">No connections yet.</p>}
        {view && view.webhooks.length > 0 && (
          <ul className="conn-list">
            {view.webhooks.map((w) => (
              <li key={w.id}>
                <strong>{w.name}</strong>
                <span className="conn-meta">{APP_LABEL[w.app]} · {w.service} · {w.host}</span>
                {isOwner && (
                  <span className="conn-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => void testHook(w.id)} disabled={testHookState.phase === "loading"}>Send test</button>
                    <button type="button" className="btn btn-danger" onClick={() => void delHook(w.id)} disabled={delState.phase === "loading"}>Remove</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {isOwner && (
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void addHook();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input value={hook.name} onChange={(e) => { setHook({ ...hook, name: e.target.value }); }} placeholder="Google Doc — meeting notes" />
            </label>
            <label className="field">
              <span>App</span>
              <select value={hook.app} onChange={(e) => { setHook({ ...hook, app: e.target.value as WebhookApp }); }}>
                {(view?.apps ?? (Object.keys(APP_LABEL) as WebhookApp[])).map((a) => (
                  <option key={a} value={a}>{APP_LABEL[a]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Webhook address</span>
              <input type="password" autoComplete="off" value={hook.url} onChange={(e) => { setHook({ ...hook, url: e.target.value }); }} placeholder="paste the address from Make (hook.eu1.make.com/…)" />
            </label>
            <div className="field-actions">
              <button type="submit" className="btn btn-primary" disabled={!hook.name.trim() || !hook.url.trim() || hookState.phase === "loading"}>Add connection</button>
            </div>
          </form>
        )}
        <p className="help">
          What JARVIS sends (map these fields in your scenario): <code>title</code>, <code>text</code>, <code>kind</code>, <code>to</code>, <code>app</code>, <code>connection</code>,{" "}
          <code>sent_at</code>, <code>test</code>. Accepted addresses: Make (hook.*.make.com), n8n Cloud, Zapier, Pipedream, or your own Google Apps Script web app.
        </p>
      </section>
    </Dialog>
  );
}
