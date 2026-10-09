// The writing agent and the customer desk.
//
// Both produce text and nothing else. What happens to it is up to you: copy
// it, open it in WhatsApp (free — you press send there), or send it to one of
// your connections after a second, explicit "Yes, send". The customer desk
// answers only from the knowledge file you keep in the third tab.
import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { Knowledge, WebhookInfo, WriteKind } from "../types";

type Tab = "write" | "customer" | "knowledge";

const KIND_LABEL: Record<WriteKind, string> = {
  email: "Email",
  message: "Chat message",
  post: "Social post",
  doc: "Document",
  code: "Code",
  other: "Anything else",
};

/** A WhatsApp link with the text filled in. Israeli 05x numbers become 9725x. */
function whatsappLink(text: string, phone: string): string {
  let digits = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (/^05\d{8}$/.test(digits)) digits = `972${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** What to do with a finished piece of text. Sending always takes two clicks. */
function Output({ text, onText, title, kind, hooks, canSend }: { text: string; onText: (t: string) => void; title: string; kind: string; hooks: WebhookInfo[]; canSend: boolean }) {
  const [phone, setPhone] = useState("");
  const [hookId, setHookId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const target = hooks.find((h) => h.id === hookId) ?? hooks[0] ?? null;
  const [send, sendState] = useAction(async () => {
    if (!target) return;
    const r = await api.sendWebhook({ id: target.id, title, text, kind });
    setConfirming(false);
    setMsg(`Sent to ${r.sent.connection} (${r.sent.service}) — ${String(r.sent.chars)} characters.`);
  });

  if (!text) return null;
  return (
    <div className="writer-out">
      <label className="field">
        <span>Result — edit freely before using it</span>
        <textarea rows={10} value={text} onChange={(e) => { onText(e.target.value); setConfirming(false); }} />
      </label>
      <div className="field-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => { setMsg("Copied."); },
              () => { setMsg("The browser refused clipboard access. Select the text and copy it."); },
            );
          }}
        >
          Copy
        </button>
        <input className="writer-phone" value={phone} onChange={(e) => { setPhone(e.target.value); }} placeholder="phone (optional)" aria-label="WhatsApp number (optional)" />
        <a className="btn btn-ghost" href={whatsappLink(text, phone)} target="_blank" rel="noopener noreferrer">
          Open in WhatsApp
        </a>
      </div>
      {canSend && hooks.length > 0 && (
        <div className="field-actions">
          <select value={target?.id ?? ""} onChange={(e) => { setHookId(e.target.value); setConfirming(false); }} aria-label="Connection">
            {hooks.map((h) => (
              <option key={h.id} value={h.id}>{h.name} — {h.service}</option>
            ))}
          </select>
          {!confirming ? (
            <button type="button" className="btn btn-primary" onClick={() => { setConfirming(true); setMsg(null); }}>Send…</button>
          ) : (
            <>
              <span className="confirm-q">Send {String(text.length)} characters to “{target?.name}”?</span>
              <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sendState.phase === "loading"}>
                {sendState.phase === "loading" ? "Sending…" : "Yes, send"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setConfirming(false); }}>Cancel</button>
            </>
          )}
        </div>
      )}
      {canSend && hooks.length === 0 && <p className="help">To send this straight into Google Docs, Gmail or another app, add a connection in Connections.</p>}
      {sendState.error && <p role="alert" className="error-text">{sendState.error}</p>}
      {msg && <p className="help" role="status">{msg}</p>}
    </div>
  );
}

export function WriterPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const language = useJarvis((s) => s.settings?.language ?? "he");
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [tab, setTab] = useState<Tab>("write");
  const [hooks, setHooks] = useState<WebhookInfo[]>([]);
  const [groqOn, setGroqOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<{ kind: WriteKind; instructions: string; tone: string }>({ kind: "email", instructions: "", tone: "" });
  const [written, setWritten] = useState("");
  const [writtenBy, setWrittenBy] = useState("");

  const [customerMsg, setCustomerMsg] = useState("");
  const [reply, setReply] = useState("");
  const [replyInfo, setReplyInfo] = useState("");

  const [kb, setKb] = useState<Knowledge | null>(null);
  const [kbNote, setKbNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, k] = await Promise.all([api.cloudStatus(), api.knowledge()]);
      setHooks(c.webhooks);
      setGroqOn(c.groq.usable);
      setKb(k.knowledge);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const [write, writeState] = useAction(async () => {
    const r = await api.write({ kind: form.kind, instructions: form.instructions, tone: form.tone, language });
    setWritten(r.text);
    setWrittenBy(`${r.provider}${r.model ? ` · ${r.model}` : ""}`);
  });
  const [answer, answerState] = useAction(async () => {
    const r = await api.customerAnswer(customerMsg);
    setReply(r.answer);
    setReplyInfo(`${r.source === "groq" ? `Groq · ${r.model ?? ""}` : "matched from the knowledge file"}${r.note ? ` — ${r.note}` : ""}`);
  });
  const [saveKb, kbState] = useAction(async () => {
    if (!kb) return;
    const r = await api.saveKnowledge(kb);
    setKb(r.knowledge);
    setKbNote(`Saved — ${String(r.knowledge.entries.length)} entries.`);
  });

  return (
    <Dialog title="Writing agent" onClose={() => { setPanel(null); }} wide>
      <div className="tabs" role="tablist">
        {(["write", "customer", "knowledge"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="tab" onClick={() => { setTab(t); }}>
            {t === "write" ? "Write for me" : t === "customer" ? "Reply to a customer" : "Knowledge"}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="error-text">{error}</p>}
      {groqOn === false && (
        <p className="banner banner-warn">
          No brain is connected for writing. Add a free Groq key in Connections (or install a local model). The customer desk still works from the knowledge file without one.
        </p>
      )}

      {tab === "write" && (
        <section>
          <p className="help">Text only: JARVIS writes it here and does nothing else with it until you choose.</p>
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void write();
            }}
          >
            <label className="field">
              <span>What</span>
              <select value={form.kind} onChange={(e) => { setForm({ ...form, kind: e.target.value as WriteKind }); }}>
                {(Object.keys(KIND_LABEL) as WriteKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Tone (optional)</span>
              <input value={form.tone} onChange={(e) => { setForm({ ...form, tone: e.target.value }); }} placeholder="friendly, formal, short…" />
            </label>
            <label className="field field-wide">
              <span>Instructions</span>
              <textarea rows={4} value={form.instructions} onChange={(e) => { setForm({ ...form, instructions: e.target.value }); }} placeholder="מייל ללקוח שמודה על הפגישה ומציע מועד נוסף ביום שלישי" />
            </label>
            <div className="field-actions">
              <button type="submit" className="btn btn-primary" disabled={!form.instructions.trim() || writeState.phase === "loading"}>
                {writeState.phase === "loading" ? "Writing…" : "Write"}
              </button>
              {writtenBy && <span className="help">by {writtenBy}</span>}
            </div>
          </form>
          {writeState.error && <p role="alert" className="error-text">{writeState.error}</p>}
          <Output text={written} onText={setWritten} title={form.instructions.slice(0, 80)} kind={form.kind} hooks={hooks} canSend={isOwner} />
        </section>
      )}

      {tab === "customer" && (
        <section>
          <p className="help">
            A separate, closed path: it reads only your knowledge file, has no tools and cannot send. A customer's message is treated as text to answer, never as instructions.
            The reply is a draft for you.
          </p>
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void answer();
            }}
          >
            <label className="field field-wide">
              <span>The customer's message</span>
              <textarea rows={4} value={customerMsg} onChange={(e) => { setCustomerMsg(e.target.value); }} placeholder="היי, אתם פתוחים בשישי?" />
            </label>
            <div className="field-actions">
              <button type="submit" className="btn btn-primary" disabled={!customerMsg.trim() || answerState.phase === "loading"}>
                {answerState.phase === "loading" ? "Drafting…" : "Draft a reply"}
              </button>
              {replyInfo && <span className="help">{replyInfo}</span>}
            </div>
          </form>
          {answerState.error && <p role="alert" className="error-text">{answerState.error}</p>}
          <Output text={reply} onText={setReply} title="Customer reply" kind="message" hooks={hooks} canSend={isOwner} />
        </section>
      )}

      {tab === "knowledge" && kb && (
        <section>
          <p className="help">Everything the customer desk is allowed to say. If a question is not covered here, it answers with the fallback sentence instead of guessing.</p>
          <div className="settings-grid">
            <label className="field field-wide">
              <span>About the business</span>
              <textarea rows={2} value={kb.business} disabled={!isOwner} onChange={(e) => { setKb({ ...kb, business: e.target.value }); }} placeholder="פיצריה בתל אביב, משלוחים עד 5 ק״מ" />
            </label>
            <label className="field field-wide">
              <span>When the answer is not here, say</span>
              <input value={kb.fallback} disabled={!isOwner} onChange={(e) => { setKb({ ...kb, fallback: e.target.value }); }} />
            </label>
          </div>
          <ol className="kb-list">
            {kb.entries.map((e, i) => (
              <li key={e.id}>
                <input value={e.q} disabled={!isOwner} aria-label={`Question ${String(i + 1)}`} placeholder="Question" onChange={(ev) => { setKb({ ...kb, entries: kb.entries.map((x) => (x.id === e.id ? { ...x, q: ev.target.value } : x)) }); }} />
                <textarea rows={2} value={e.a} disabled={!isOwner} aria-label={`Answer ${String(i + 1)}`} placeholder="Answer" onChange={(ev) => { setKb({ ...kb, entries: kb.entries.map((x) => (x.id === e.id ? { ...x, a: ev.target.value } : x)) }); }} />
                {isOwner && (
                  <button type="button" className="btn btn-ghost" onClick={() => { setKb({ ...kb, entries: kb.entries.filter((x) => x.id !== e.id) }); }}>Remove</button>
                )}
              </li>
            ))}
          </ol>
          {isOwner && (
            <div className="field-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setKb({ ...kb, entries: [...kb.entries, { id: `e${String(Date.now())}`, q: "", a: "" }] }); }}>Add a question</button>
              <button type="button" className="btn btn-primary" onClick={() => void saveKb()} disabled={kbState.phase === "loading"}>Save knowledge</button>
            </div>
          )}
          {kbState.error && <p role="alert" className="error-text">{kbState.error}</p>}
          {kbNote && <p className="help" role="status">{kbNote}</p>}
        </section>
      )}
    </Dialog>
  );
}
