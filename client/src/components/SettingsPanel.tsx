import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { useJarvis } from "../state/jarvisStore";
import type { ConnectionTestResult, PermissionMode, SettingsUpdate } from "../types";

const STATUS_LABEL: Record<ConnectionTestResult["status"], string> = {
  connected: "Connected",
  missing_key: "Missing key",
  invalid_key: "Invalid key",
  error: "Error",
  mock: "Mock mode",
};

export function SettingsPanel() {
  const open = useJarvis((s) => s.settingsOpen);
  const settings = useJarvis((s) => s.settings);
  const openSettings = useJarvis((s) => s.openSettings);
  const refreshSettings = useJarvis((s) => s.refreshSettings);
  const addLog = useJarvis((s) => s.addLog);

  const [form, setForm] = useState<SettingsUpdate>({});
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setForm({});
    setApiKey("");
    setShowKey(false);
    setClearKey(false);
    setTest(null);
    setError(null);
    void refreshSettings();
    const previous = document.activeElement as HTMLElement | null;
    window.setTimeout(() => firstRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        openSettings(false);
      }
      if (e.key === "Tab" && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)");
        const first = f[0];
        const last = f[f.length - 1];
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
  }, [open, openSettings, refreshSettings]);

  if (!open || !settings) return null;

  const value = (k: "provider" | "model" | "base_url" | "workspace_dir"): string => form[k] ?? settings[k];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const update: SettingsUpdate = { ...form };
      if (clearKey) update.api_key = "";
      else if (apiKey.trim()) update.api_key = apiKey.trim();
      const view = await api.updateSettings(update);
      useJarvis.setState({ settings: view });
      setApiKey(""); // the key never lingers in component state after saving
      setClearKey(false);
      setForm({});
      addLog("system", view.mock_mode ? "Settings saved. Mock mode (no API key)." : `Settings saved. Provider ${view.provider}, model ${view.model}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testConnection());
    } catch (err) {
      setTest({ status: "error", detail: err instanceof Error ? err.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="backdrop" role="presentation">
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>
        <p>Secrets stay on the local server. The browser only ever sees whether a key is set.</p>

        <form onSubmit={(e) => void save(e)} className="settings-grid">
          <div className="field">
            <label htmlFor="s-provider">Provider</label>
            <input
              id="s-provider"
              ref={firstRef}
              value={value("provider")}
              onChange={(e) => {
                setForm({ ...form, provider: e.target.value });
              }}
              placeholder="openai-compatible"
            />
          </div>
          <div className="field">
            <label htmlFor="s-model">Model</label>
            <input
              id="s-model"
              value={value("model")}
              onChange={(e) => {
                setForm({ ...form, model: e.target.value });
              }}
              placeholder="gpt-4o-mini"
            />
          </div>

          <div className="field span-2">
            <label htmlFor="s-base">Base URL (OpenAI-compatible)</label>
            <input
              id="s-base"
              value={value("base_url")}
              onChange={(e) => {
                setForm({ ...form, base_url: e.target.value });
              }}
              placeholder="https://api.openai.com/v1"
              inputMode="url"
            />
            <span className="help">Works with OpenAI, Ollama (http://localhost:11434/v1), LM Studio, OpenRouter and similar.</span>
          </div>

          <div className="field span-2">
            <label htmlFor="s-key">API key {settings.has_api_key && !clearKey ? `(set, ${settings.api_key_hint})` : "(not set)"}</label>
            <div className="field-row">
              <input
                id="s-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setClearKey(false);
                }}
                placeholder={settings.has_api_key ? "Enter a new key to replace" : "sk-…"}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => {
                  setShowKey((v) => !v);
                }} aria-pressed={showKey} aria-label={showKey ? "Hide key" : "Show key"}>
                {showKey ? "Hide" : "Show"}
              </button>
              {settings.has_api_key && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setClearKey(true);
                    setApiKey("");
                  }}
                  aria-pressed={clearKey}
                >
                  Clear
                </button>
              )}
            </div>
            <span className="help">Write-only. Stored in server memory for this session; put it in .env to persist.</span>
          </div>

          <div className="field span-2">
            <label htmlFor="s-ws">Allowed workspace directory</label>
            <input
              id="s-ws"
              value={value("workspace_dir")}
              onChange={(e) => {
                setForm({ ...form, workspace_dir: e.target.value });
              }}
            />
            <span className="help">File search, read and create actions are confined to this folder.</span>
          </div>

          <div className="field span-2">
            <label htmlFor="s-mode">Automation permission mode</label>
            <select
              id="s-mode"
              value={(form.permission_mode ?? settings.permission_mode) satisfies PermissionMode}
              onChange={(e) => {
                setForm({ ...form, permission_mode: e.target.value as PermissionMode });
              }}
            >
              <option value="manual">Manual: confirm every action</option>
              <option value="ask">Ask: run low-risk, confirm medium and high (recommended)</option>
              <option value="auto">Auto: run low and medium, confirm high</option>
            </select>
            <span className="help">
              Allowed sites: {settings.allowed_url_hosts.join(", ")}. Allowed apps: {settings.allowed_apps.join(", ")}.
            </span>
          </div>

          {error && (
            <p role="alert" className="span-2" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <div className="dialog-actions span-2">
            <span className="status-chip" data-status={test?.status ?? (settings.mock_mode ? "mock" : settings.has_api_key ? "connected" : "missing_key")} aria-live="polite">
              <span className="dot" aria-hidden="true" />
              {test ? `${STATUS_LABEL[test.status]}: ${test.detail}` : settings.mock_mode ? "Mock mode" : settings.has_api_key ? "Key set (not tested)" : "Missing key"}
            </span>
            <button type="button" className="btn" onClick={() => void runTest()} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => {
                openSettings(false);
              }}>
              Close
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
