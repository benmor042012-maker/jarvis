import { useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { localVoices, speak, speechAvailable } from "../lib/speech";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { AppInfo, Settings, SettingsUpdate } from "../types";

export function SettingsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const settings = useJarvis((s) => s.settings);
  const refreshSettings = useJarvis((s) => s.refreshSettings);
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [form, setForm] = useState<SettingsUpdate>({});
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);
  const [tested, setTested] = useState<string | null>(null);

  // Chrome fills the voice list asynchronously, and it changes when a voice is
  // installed or removed while the page is open.
  useEffect(() => {
    if (!speechAvailable()) return;
    const read = () => { setVoices(localVoices()); };
    read();
    window.speechSynthesis.addEventListener("voiceschanged", read);
    return () => { window.speechSynthesis.removeEventListener("voiceschanged", read); };
  }, []);

  useEffect(() => {
    void refreshSettings();
    void api
      .apps()
      .then((r) => { setApps(r.apps); })
      .catch(() => undefined);
  }, [refreshSettings]);

  const [save, saveState] = useAction(async () => {
    setError(null);
    await api.updateSettings(form);
    await refreshSettings();
    setForm({});
  });

  if (!settings) {
    return (
      <Dialog title="Settings" onClose={() => { setPanel(null); }}>
        <p className="help">Loading settings…</p>
      </Dialog>
    );
  }

  const v = <K extends keyof SettingsUpdate>(k: K): Settings[K] => (form[k] as Settings[K] | undefined) ?? settings[k];
  const ai = { ...settings.ai, ...(form.ai ?? {}) };
  const server = { ...settings.server, ...(form.server ?? {}) };
  const voice = { ...settings.voice, ...(form.voice ?? {}) };
  const alerts = { ...settings.alerts, ...(form.alerts ?? {}) };
  const phone = { ...settings.phone, ...(form.phone ?? {}) };
  const lines = (text: string) => text.split("\n").map((s2) => s2.trim()).filter(Boolean);

  return (
    <Dialog title="Settings" onClose={() => { setPanel(null); }} wide>
      {!isOwner && <p className="banner banner-warn">Settings can only be changed from the JARVIS computer itself. This is a read-only view.</p>}
      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Behaviour</legend>
          <div className="settings-grid">
            <label className="field">
              <span>Permission mode</span>
              <select value={v("mode")} onChange={(e) => { setForm({ ...form, mode: e.target.value as Settings["mode"] }); }}>
                <option value="safe">Safe — read-only, reversible actions only</option>
                <option value="assistant">Assistant — asks for medium and high risk</option>
                <option value="advanced">Advanced — your per-tool policy (high risk still asks)</option>
              </select>
            </label>
            <label className="field">
              <span>Language</span>
              <select value={v("language")} onChange={(e) => { setForm({ ...form, language: e.target.value as "he" | "en" }); }}>
                <option value="he">עברית</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="check span-2">
              <input type="checkbox" checked={v("offlineMode")} onChange={(e) => { setForm({ ...form, offlineMode: e.target.checked }); }} />
              Offline mode — refuse anything that would use the network. Local models on this computer keep working; project installs and web pages are skipped with a reason, never faked.
            </label>
            <label className="check span-2">
              <input type="checkbox" checked={v("autoStart")} onChange={(e) => { setForm({ ...form, autoStart: e.target.checked }); }} />
              Start JARVIS automatically when Windows starts (hidden, in the tray)
            </label>
            <label className="field span-2">
              <span>Emergency stop hotkey</span>
              <input value={(form.hotkeys ?? settings.hotkeys).emergencyStop} onChange={(e) => { setForm({ ...form, hotkeys: { emergencyStop: e.target.value } }); }} placeholder="CommandOrControl+Shift+Escape" />
              <span className="help">
                Currently active: {settings.hotkeyActive?.active ?? "not registered"}
                {settings.hotkeyActive?.error ? ` — ${settings.hotkeyActive.error}` : ""}. Windows reserves Ctrl+Shift+Esc for Task Manager on some systems; JARVIS falls back to Ctrl+Alt+Shift+Esc and says so here.
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Local AI</legend>
          <div className="settings-grid">
            <label className="field">
              <span>Provider</span>
              <select value={ai.provider} onChange={(e) => { setForm({ ...form, ai: { ...ai, provider: e.target.value as Settings["ai"]["provider"] } }); }}>
                <option value="auto">Auto-detect (Ollama, then LocalAI)</option>
                <option value="ollama">Ollama</option>
                <option value="localai">LocalAI</option>
                <option value="mock">Rule planner only (MOCK MODE)</option>
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input value={ai.model} onChange={(e) => { setForm({ ...form, ai: { ...ai, model: e.target.value } }); }} placeholder="llama3.2 (blank = first installed)" />
            </label>
            <label className="field">
              <span>Ollama URL</span>
              <input value={ai.ollamaUrl} onChange={(e) => { setForm({ ...form, ai: { ...ai, ollamaUrl: e.target.value } }); }} />
            </label>
            <label className="field">
              <span>LocalAI URL</span>
              <input value={ai.localaiUrl} onChange={(e) => { setForm({ ...form, ai: { ...ai, localaiUrl: e.target.value } }); }} />
            </label>
            <p className="help span-2">Only addresses on this computer or your local network are accepted. There is no cloud option, and no API key field, because nothing here talks to a paid provider.</p>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Access from other devices</legend>
          <div className="settings-grid">
            <label className="check span-2">
              <input type="checkbox" checked={server.lanEnabled} onChange={(e) => { setForm({ ...form, server: { ...server, lanEnabled: e.target.checked } }); }} />
              Allow devices on my Wi-Fi/LAN to reach JARVIS (still requires pairing and a signed request for every command)
            </label>
            <label className="field">
              <span>Port</span>
              <input type="number" min={1024} max={65535} value={server.port} onChange={(e) => { setForm({ ...form, server: { ...server, port: Number(e.target.value) } }); }} />
            </label>
            <label className="field">
              <span>New device expiry (days, 0 = never)</span>
              <input type="number" min={0} max={365} value={v("deviceExpiryDays")} onChange={(e) => { setForm({ ...form, deviceExpiryDays: Number(e.target.value) }); }} />
            </label>
            <p className="help span-2">There is no relay and no tunnel: JARVIS is never exposed to the public internet by this app. Access from outside your home would need a private network you set up yourself (e.g. WireGuard or Tailscale), and even then every command is signed and can be revoked.</p>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>What JARVIS may touch</legend>
          <div className="settings-grid">
            <label className="field span-2">
              <span>Approved folders (one per line — file tools work only inside these)</span>
              <textarea rows={3} value={(form.approvedFolders ?? settings.approvedFolders).join("\n")} onChange={(e) => { setForm({ ...form, approvedFolders: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }); }} />
            </label>
            <label className="field span-2">
              <span>Allowed web hosts for “open page” (one per line, * = any)</span>
              <textarea rows={2} value={(form.allowedUrlHosts ?? settings.allowedUrlHosts).join("\n")} onChange={(e) => { setForm({ ...form, allowedUrlHosts: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }); }} />
            </label>
            <label className="field span-2">
              <span>Extra applications (one per line: id = full path)</span>
              <textarea
                rows={2}
                value={(form.extraApps ?? settings.extraApps).map((a) => `${a.id} = ${a.path}`).join("\n")}
                onChange={(e) => {
                  setForm({
                    ...form,
                    extraApps: e.target.value
                      .split("\n")
                      .map((line) => line.split("="))
                      .filter((p) => p.length >= 2)
                      .map((p) => ({ id: (p[0] ?? "").trim(), path: p.slice(1).join("=").trim() }))
                      .filter((a) => a.id && a.path),
                  });
                }}
                placeholder={"excel = C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE"}
              />
              <span className="help">Built-in apps available here: {apps.filter((a) => a.available).map((a) => a.id).join(", ") || "—"}</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Voice</legend>
          <div className="settings-grid">
            <label className="check span-2">
              <input type="checkbox" checked={voice.enabled} onChange={(e) => { setForm({ ...form, voice: { ...voice, enabled: e.target.checked } }); }} />
              Let JARVIS listen for the wake phrase
            </label>
            <label className="field">
              <span>Wake phrases (one per line)</span>
              <textarea rows={2} value={voice.wakePhrases.join("\n")} onChange={(e) => { setForm({ ...form, voice: { ...voice, wakePhrases: lines(e.target.value) } }); }} />
            </label>
            <label className="field">
              <span>Stop phrases (stop everything, no model involved)</span>
              <textarea rows={2} value={voice.stopPhrases.join("\n")} onChange={(e) => { setForm({ ...form, voice: { ...voice, stopPhrases: lines(e.target.value) } }); }} />
            </label>
            <label className="field">
              <span>Speech language</span>
              <select value={voice.language} onChange={(e) => { setForm({ ...form, voice: { ...voice, language: e.target.value } }); }}>
                <option value="he">Hebrew (עברית)</option>
                <option value="en">English</option>
                <option value="auto">Whatever is spoken (slower, and guesses)</option>
              </select>
            </label>
            <label className="field">
              <span>Speed</span>
              <select value={voice.mode} onChange={(e) => { setForm({ ...form, voice: { ...voice, mode: e.target.value as "fast" | "accurate" } }); }}>
                <option value="fast">Fast — the quickest model installed, one pass</option>
                <option value="accurate">Accurate — the model below, full search</option>
              </select>
            </label>
            <label className="field">
              <span>Graphics card</span>
              <select value={voice.gpu} onChange={(e) => { setForm({ ...form, voice: { ...voice, gpu: e.target.value as "auto" | "off" } }); }}>
                <option value="auto">Use one if this computer has a supported one</option>
                <option value="off">Processor only</option>
              </select>
            </label>
            <label className="field span-2">
              <span>Speech model file (leave empty to let JARVIS find one)</span>
              <input value={voice.whisperModel} onChange={(e) => { setForm({ ...form, voice: { ...voice, whisperModel: e.target.value } }); }} placeholder="C:\Users\you\.jarvis\speech\ggml-small.bin" />
            </label>
            <label className="field">
              <span>Maximum listening time after waking (seconds)</span>
              <input type="number" min={2} max={120} value={Math.round(voice.maxListenMs / 1000)} onChange={(e) => { setForm({ ...form, voice: { ...voice, maxListenMs: Number(e.target.value) * 1000 } }); }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={voice.quietHours.enabled} onChange={(e) => { setForm({ ...form, voice: { ...voice, quietHours: { ...voice.quietHours, enabled: e.target.checked } } }); }} />
              Quiet hours
            </label>
            <div className="field-row">
              <label className="field">
                <span>From</span>
                <input type="time" value={voice.quietHours.start} onChange={(e) => { setForm({ ...form, voice: { ...voice, quietHours: { ...voice.quietHours, start: e.target.value } } }); }} />
              </label>
              <label className="field">
                <span>To</span>
                <input type="time" value={voice.quietHours.end} onChange={(e) => { setForm({ ...form, voice: { ...voice, quietHours: { ...voice.quietHours, end: e.target.value } } }); }} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={voice.speakReplies} onChange={(e) => { setForm({ ...form, voice: { ...voice, speakReplies: e.target.checked } }); }} />
              Speak the reply after a voice command
            </label>
            <label className="check">
              <input type="checkbox" checked={voice.conversation} onChange={(e) => { setForm({ ...form, voice: { ...voice, conversation: e.target.checked } }); }} />
              Keep listening after the answer, so a follow-up does not need the wake word again
            </label>
            <label className="field">
              <span>How long to keep listening for a follow-up (seconds)</span>
              <input type="number" min={2} max={60} value={Math.round(voice.followUpMs / 1000)} onChange={(e) => { setForm({ ...form, voice: { ...voice, followUpMs: Number(e.target.value) * 1000 } }); }} disabled={!voice.conversation} />
            </label>
            <label className="check">
              <input type="checkbox" checked={voice.keepAudio} onChange={(e) => { setForm({ ...form, voice: { ...voice, keepAudio: e.target.checked } }); }} />
              Keep the recordings on this computer (off by default — JARVIS deletes each temporary WAV right after transcribing it)
            </label>
            <label className="field">
              <span>whisper.cpp program (blank = look in the usual places)</span>
              <input value={voice.whisperPath} onChange={(e) => { setForm({ ...form, voice: { ...voice, whisperPath: e.target.value } }); }} placeholder="C:\\whisper\\whisper-cli.exe" />
            </label>
            <label className="field">
              <span>whisper.cpp model file</span>
              <input value={voice.whisperModel} onChange={(e) => { setForm({ ...form, voice: { ...voice, whisperModel: e.target.value } }); }} placeholder="C:\\whisper\\ggml-small.bin" />
            </label>
            <p className="help span-2">Speech is recognised by a program installed on this computer. No audio is uploaded anywhere, and there is no speech service, account or key.</p>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Customer alerts</legend>
          <div className="settings-grid">
            <label className="check span-2">
              <input type="checkbox" checked={alerts.enabled} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, enabled: e.target.checked } }); }} />
              Watch the local customer records and alert me when one turns urgent
            </label>
            <label className="field">
              <span>Check every (minutes)</span>
              <input type="number" min={1} max={60} value={Math.round(alerts.scanIntervalMs / 60000)} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, scanIntervalMs: Number(e.target.value) * 60000 } }); }} />
            </label>
            <div className="field span-2">
              <span>How to alert me</span>
              <label className="check">
                <input type="checkbox" checked={alerts.channels.notification} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, channels: { ...alerts.channels, notification: e.target.checked } } }); }} />
                Windows notification
              </label>
              <label className="check">
                <input type="checkbox" checked={alerts.channels.sound} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, channels: { ...alerts.channels, sound: e.target.checked } } }); }} />
                Sound
              </label>
              <label className="check">
                <input type="checkbox" checked={alerts.channels.speech} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, channels: { ...alerts.channels, speech: e.target.checked } } }); }} />
                Say it out loud
              </label>
              <label className="check">
                <input type="checkbox" checked={alerts.channels.phone} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, channels: { ...alerts.channels, phone: e.target.checked } } }); }} />
                Paired phones on this Wi-Fi
              </label>
            </div>
            <label className="check span-2">
              <input type="checkbox" checked={alerts.speakDetails} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, speakDetails: e.target.checked } }); }} />
              Also say the reason out loud (off by default — private customer detail stays on screen)
            </label>
            <label className="check">
              <input type="checkbox" checked={alerts.quietHours.enabled} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, quietHours: { ...alerts.quietHours, enabled: e.target.checked } } }); }} />
              Quiet hours (the alert still appears, it just makes no noise)
            </label>
            <div className="field-row">
              <label className="field">
                <span>From</span>
                <input type="time" value={alerts.quietHours.start} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, quietHours: { ...alerts.quietHours, start: e.target.value } } }); }} />
              </label>
              <label className="field">
                <span>To</span>
                <input type="time" value={alerts.quietHours.end} onChange={(e) => { setForm({ ...form, alerts: { ...alerts, quietHours: { ...alerts.quietHours, end: e.target.value } } }); }} />
              </label>
            </div>
            <p className="help span-2">LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES. Alerts reach this screen, this computer and paired phones on your own network. No Telegram, WhatsApp, SMS, email, Firebase or push service is used.</p>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Phone calls</legend>
          <div className="settings-grid">
            <label className="check span-2">
              <input type="checkbox" checked={phone.enabled} onChange={(e) => { setForm({ ...form, phone: { ...phone, enabled: e.target.checked } }); }} />
              Allow JARVIS to ask to call a customer (you still approve every number, and your phone still places the call)
            </label>
            <label className="check span-2">
              <input type="checkbox" checked={phone.simulation} onChange={(e) => { setForm({ ...form, phone: { ...phone, simulation: e.target.checked } }); }} />
              Simulation only — run the whole flow without ever opening a dialer
            </label>
            <label className="check span-2">
              <input type="checkbox" checked={phone.allowDialer} onChange={(e) => { setForm({ ...form, phone: { ...phone, allowDialer: e.target.checked } }); }} />
              Let an approved call open the dialer on a paired phone
            </label>
            <p className="help span-2">JARVIS cannot answer an incoming call and cannot press the call button for you. Those need an installed Android app with the ANSWER_PHONE_CALLS permission, which this project does not ship — see the Phone panel for the exact reason.</p>
          </div>
        </fieldset>

        <fieldset className="span-2" disabled={!isOwner}>
          <legend>Drafts and privacy</legend>
          <div className="settings-grid">
            <label className="field">
              <span>Your name (signature in drafts)</span>
              <input value={(form.drafts ?? settings.drafts).senderName} onChange={(e) => { setForm({ ...form, drafts: { ...(form.drafts ?? settings.drafts), senderName: e.target.value } }); }} />
            </label>
            <label className="field">
              <span>Business name</span>
              <input value={(form.drafts ?? settings.drafts).businessName} onChange={(e) => { setForm({ ...form, drafts: { ...(form.drafts ?? settings.drafts), businessName: e.target.value } }); }} />
            </label>
            <label className="field">
              <span>Contacts — one per line: name, phone. Kept only on this computer; "שלח וואטסאפ ל&lt;שם&gt; ש…" opens the chat with the message typed and you press Send</span>
              <textarea
                rows={4}
                dir="auto"
                value={(form.contacts ?? settings.contacts).map((c) => `${c.name}, ${c.phone}`).join("\n")}
                onChange={(e) => {
                  const contacts = e.target.value.split("\n").map((line) => {
                    const i = line.indexOf(",");
                    return i < 0 ? { name: line.trim(), phone: "" } : { name: line.slice(0, i).trim(), phone: line.slice(i + 1).trim() };
                  });
                  setForm({ ...form, contacts });
                }}
                placeholder={"אמא, 050-123-4567\nDana, +972 52 000 0000"}
              />
            </label>
            <label className="field">
              <span>Keep activity log for (days)</span>
              <input type="number" min={1} max={365} value={(form.privacy ?? settings.privacy).keepAuditDays} onChange={(e) => { setForm({ ...form, privacy: { keepAuditDays: Number(e.target.value) } }); }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={(form.tts ?? settings.tts).enabled} onChange={(e) => { setForm({ ...form, tts: { ...(form.tts ?? settings.tts), enabled: e.target.checked } }); }} />
              Speak replies out loud
            </label>
            <label className="field">
              <span>Voice</span>
              <select value={(form.tts ?? settings.tts).voice} onChange={(e) => { setForm({ ...form, tts: { ...(form.tts ?? settings.tts), voice: e.target.value } }); }}>
                <option value="">First voice installed for the language</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>{`${v.name} (${v.lang})`}</option>
                ))}
              </select>
            </label>
            <p className="help">
              {voices.length
                ? "Only voices installed on this computer are listed — nothing is spoken by a remote service. Add more in Windows Settings → Time & language → Speech → Manage voices."
                : "No local voice is installed, or this browser has none. Add one free in Windows Settings → Time & language → Speech → Manage voices."}
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!voices.length}
              onClick={() => {
                const pick = (form.tts ?? settings.tts);
                const lang = pick.lang || ((form.language ?? settings.language) === "en" ? "en-US" : "he-IL");
                setTested(null);
                void speak(lang.startsWith("he") ? "שלום, אני ג'רביס. ככה אני נשמע." : "Hello, this is JARVIS. This is how I sound.", lang, pick.voice || null).then((res) => {
                  setTested(res.spoken ? "Spoken." : (res.reason ?? "Nothing was spoken."));
                });
              }}
            >
              Hear this voice
            </button>
            {tested && <p className="help">{tested}</p>}
          </div>
        </fieldset>

        {(error ?? saveState.error) && (
          <p role="alert" className="error-text span-2">
            {error ?? saveState.error}
          </p>
        )}
        <div className="dialog-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={() => { setForm({}); }} disabled={Object.keys(form).length === 0}>
            Discard changes
          </button>
          <button type="submit" className="btn btn-primary" disabled={!isOwner || saveState.phase === "loading" || Object.keys(form).length === 0}>
            {saveState.phase === "loading" ? "Saving…" : saveState.phase === "success" ? "Saved ✓" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
