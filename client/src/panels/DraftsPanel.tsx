import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { Draft, DraftTemplate } from "../types";

export function DraftsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const language = useJarvis((s) => s.settings?.language ?? "he");
  const [templates, setTemplates] = useState<DraftTemplate[]>([]);
  const [label, setLabel] = useState("DRAFT ONLY — NOTHING IS SENT");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [optout, setOptout] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ recipient: "", purpose: "follow_up", language, name: "", topic: "", body: "", style: "", timing: "", attachments: "", improve: false, translate_to: "" });
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, d] = await Promise.all([api.draftTemplates(form.language), api.drafts()]);
      setTemplates(t.templates);
      setLabel(t.label);
      setDrafts(d.drafts);
      setOptout(d.optout);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [form.language]);
  useEffect(() => {
    void load();
  }, [load]);

  const [create, createState] = useAction(async () => {
    await api.createDraft({
      recipient: form.recipient,
      purpose: form.purpose,
      language: form.language,
      name: form.name,
      topic: form.topic,
      body: form.body,
      style: form.style,
      timing: form.timing,
      attachments: form.attachments.split(",").map((s) => s.trim()).filter(Boolean),
      improve: form.improve,
      translate_to: form.translate_to,
    });
    await load();
  });

  const [remove, removeState] = useAction(async (id: string) => {
    await api.deleteDraft(id);
    await load();
  });

  const [exportOne, exportState] = useAction(async (id: string) => {
    await api.exportDraft(id);
    await load();
  });

  const copy = async (d: Draft) => {
    try {
      await navigator.clipboard.writeText(d.text);
      setCopied(d.id);
      window.setTimeout(() => { setCopied(null); }, 1600);
    } catch {
      setError("The browser refused clipboard access. Select the text and copy it manually.");
    }
  };

  return (
    <Dialog title="Customer drafts" onClose={() => { setPanel(null); }} wide>
      <p className="banner banner-warn">{label}. JARVIS has no sending adapters at all — no email, no WhatsApp, no SMS, no social media. You copy or export a draft and send it yourself, through whatever you already use.</p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      <section>
        <h3>New draft</h3>
        <form
          className="settings-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field">
            <span>Recipient (who it is for)</span>
            <input value={form.recipient} onChange={(e) => { setForm({ ...form, recipient: e.target.value }); }} placeholder="dan@example.com or 050-1234567" />
          </label>
          <label className="field">
            <span>Purpose</span>
            <select value={form.purpose} onChange={(e) => { setForm({ ...form, purpose: e.target.value }); }}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Their name</span>
            <input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} />
          </label>
          <label className="field">
            <span>Topic</span>
            <input value={form.topic} onChange={(e) => { setForm({ ...form, topic: e.target.value }); }} placeholder="the kitchen renovation" />
          </label>
          <label className="field">
            <span>Language</span>
            <select value={form.language} onChange={(e) => { setForm({ ...form, language: e.target.value as "he" | "en" }); }}>
              <option value="he">עברית</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field">
            <span>Tone</span>
            <select value={form.style} onChange={(e) => { setForm({ ...form, style: e.target.value }); }}>
              <option value="">As written</option>
              <option value="formal">More formal</option>
              <option value="friendly">Friendlier</option>
              <option value="short">Shorter</option>
            </select>
          </label>
          <label className="field">
            <span>Timing (when you intend to send it)</span>
            <input value={form.timing} onChange={(e) => { setForm({ ...form, timing: e.target.value }); }} placeholder="tomorrow morning" />
          </label>
          <label className="field">
            <span>Attachments to include by hand</span>
            <input value={form.attachments} onChange={(e) => { setForm({ ...form, attachments: e.target.value }); }} placeholder="quote.pdf, photo.jpg" />
          </label>
          <label className="field span-2">
            <span>Message (required for “Custom message”, otherwise extra notes)</span>
            <textarea rows={3} value={form.body} onChange={(e) => { setForm({ ...form, body: e.target.value }); }} />
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.improve} onChange={(e) => { setForm({ ...form, improve: e.target.checked }); }} />
            Improve the wording with the local model (if one is installed; otherwise deterministic rules are used and the draft says so)
          </label>
          <label className="field span-2">
            <span>Translate to</span>
            <select value={form.translate_to} onChange={(e) => { setForm({ ...form, translate_to: e.target.value }); }}>
              <option value="">No translation</option>
              <option value="en">English</option>
              <option value="he">עברית</option>
            </select>
          </label>
          <div className="dialog-actions span-2">
            <button type="submit" className="btn btn-primary" disabled={createState.phase === "loading"}>
              {createState.phase === "loading" ? "Drafting…" : createState.phase === "success" ? "Draft created ✓" : "Create draft"}
            </button>
          </div>
          {createState.error && (
            <p role="alert" className="error-text span-2">
              {createState.error}
            </p>
          )}
        </form>
      </section>

      <section>
        <h3>Drafts ({drafts.length})</h3>
        {optout.length > 0 && <p className="help">Opt-out list: {optout.join(", ")}</p>}
        {loading && drafts.length === 0 && <p className="help">Loading…</p>}
        {!loading && drafts.length === 0 && <p className="log-empty">No drafts yet.</p>}
        <ul className="list">
          {drafts.map((d) => (
            <li key={d.id} className="list-item column">
              <div className="row">
                <strong>
                  {d.purpose} → {d.recipient || "(no recipient)"}
                </strong>
                <span className="help">
                  {new Date(d.created_at).toLocaleString()} · {d.language} {d.model ? `· ${d.model}` : "· template"} {d.timing ? `· send ${d.timing}` : ""}
                </span>
              </div>
              {d.warnings.map((w) => (
                <p key={w.code} className="banner banner-warn">
                  {w.text}
                </p>
              ))}
              {d.notes.map((n, i) => (
                <p key={i} className="help">
                  ⚠ {n}
                </p>
              ))}
              <pre className="draft-text">{d.text}</pre>
              {d.attachments.length > 0 && <p className="help">Attach by hand: {d.attachments.join(", ")}</p>}
              <div className="row">
                <button type="button" className="btn" onClick={() => void copy(d)}>
                  {copied === d.id ? "Copied ✓" : "Copy"}
                </button>
                <button type="button" className="btn" onClick={() => void exportOne(d.id)} disabled={exportState.phase === "loading"}>
                  Export to file
                </button>
                <button type="button" className="btn" onClick={() => void api.optOut(d.recipient).then(load)} disabled={!d.recipient}>
                  Add recipient to opt-out
                </button>
                <button type="button" className="btn btn-danger" onClick={() => void remove(d.id)} disabled={removeState.phase === "loading"}>
                  Delete
                </button>
                {d.exported_path && <span className="help">Saved: {d.exported_path}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
