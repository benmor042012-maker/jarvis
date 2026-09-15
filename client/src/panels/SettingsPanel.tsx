import { useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
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
              <span>Keep activity log for (days)</span>
              <input type="number" min={1} max={365} value={(form.privacy ?? settings.privacy).keepAuditDays} onChange={(e) => { setForm({ ...form, privacy: { keepAuditDays: Number(e.target.value) } }); }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={(form.tts ?? settings.tts).enabled} onChange={(e) => { setForm({ ...form, tts: { ...(form.tts ?? settings.tts), enabled: e.target.checked } }); }} />
              Speak replies out loud
            </label>
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
