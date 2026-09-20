import { useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { AiStatus } from "../types";

export function StatusPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const status = useJarvis((s) => s.status);
  const health = useJarvis((s) => s.health);
  const lastSeen = useJarvis((s) => s.lastSeen);
  const connection = useJarvis((s) => s.connection);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [detect, detectState] = useAction(async (force: boolean) => {
    setAiError(null);
    try {
      setAi(await api.aiDetect(force));
    } catch (err) {
      setAiError(describeError(err));
      throw err;
    }
  });

  useEffect(() => {
    if (connection === "online") void detect(false);
  }, [connection, detect]);

  const c = status?.cost_network;

  return (
    <Dialog title="Status" onClose={() => { setPanel(null); }} wide>
      <div className="grid-2">
        <section>
          <h3>Agent</h3>
          <dl className="kv">
            <dt>State</dt>
            <dd>{connection === "online" ? status?.state ?? "—" : connection}</dd>
            <dt>Version</dt>
            <dd>{status?.version ?? health?.version ?? "—"}</dd>
            <dt>Host</dt>
            <dd>{status?.host === "desktop" ? "Desktop app (tray, hotkey, browser automation)" : "Headless agent (no tray, no native confirmation)"}</dd>
            <dt>Platform</dt>
            <dd>{status?.platform ?? "—"}</dd>
            <dt>Last contact</dt>
            <dd>{lastSeen ? new Date(lastSeen).toLocaleTimeString() : "never"}</dd>
            <dt>Emergency hotkey</dt>
            <dd>{status?.hotkey.active ?? "not registered"}{status?.hotkey.error ? ` — ${status.hotkey.error}` : ""}</dd>
            <dt>Network access</dt>
            <dd>{status?.lan.enabled ? `LAN on port ${String(status.lan.port)}` : `This computer only (127.0.0.1:${String(status?.lan.port ?? 0)})`}</dd>
            {status?.lan.enabled &&
              status.lan.addresses.map((a) => (
                <span key={a.address} style={{ gridColumn: "1 / -1" }} className="help">
                  http://{a.address}:{status.lan.port}/ ({a.iface})
                </span>
              ))}
          </dl>
        </section>

        <section>
          <h3>Cost & network</h3>
          <dl className="kv">
            <dt>Local AI only</dt>
            <dd data-ok={c?.local_ai_only ? "yes" : "no"}>{c?.local_ai_only ? "Yes" : "No"}</dd>
            <dt>External calls</dt>
            <dd data-ok={c?.external_calls === 0 ? "yes" : "no"}>{c?.external_calls ?? "—"}</dd>
            <dt>API keys configured</dt>
            <dd data-ok={c?.api_keys_configured === 0 ? "yes" : "no"}>{c?.api_keys_configured ?? "—"}</dd>
            <dt>Payment configured</dt>
            <dd data-ok={c?.payment_configured === false ? "yes" : "no"}>{c?.payment_configured ? "Yes" : "No"}</dd>
            <dt>Outgoing messages</dt>
            <dd data-ok="yes">{c?.outgoing_messages ?? 0} (sending is not implemented)</dd>
            <dt>Cloud providers</dt>
            <dd>{c?.cloud_providers ?? "—"}</dd>
            <dt>Data leaving this computer</dt>
            <dd>{c?.data_leaving_computer ?? "—"}</dd>
            <dt>Connected devices</dt>
            <dd>{status ? `${String(status.devices.connected)} live · ${String(status.devices.paired)} paired` : "—"}</dd>
            <dt>Offline mode</dt>
            <dd>{status?.offline_mode ? "On — network features are disabled" : "Off"}</dd>
          </dl>
        </section>
      </div>

      <section>
        <h3>Local AI</h3>
        {detectState.phase === "loading" && !ai && <p className="help">Looking for Ollama and LocalAI…</p>}
        {aiError && (
          <p role="alert" className="error-text">
            {aiError}
          </p>
        )}
        {ai && (
          <>
            <p className={ai.mock_mode ? "banner banner-warn" : "banner banner-ok"}>
              {ai.mock_mode ? `MOCK MODE — ${ai.active.reason}. Commands still work through the built-in rule planner; results are deterministic, not conversational.` : `Active: ${ai.active.provider} · ${ai.active.model ?? ""} (${ai.active.reason})`}
            </p>
            {!ai.mock_mode && <p className="help">⚠ {ai.capability_warning}</p>}
            <dl className="kv">
              <dt>Ollama program</dt>
              <dd>{ai.detected.cli?.available ? `${String(ai.detected.cli.models.length)} model(s): ${ai.detected.cli.models.join(", ")} · run directly, no socket` : `not available — ${ai.detected.cli?.error ?? "unknown"}`}</dd>
              <dt>Ollama server</dt>
              <dd>{ai.detected.ollama.available ? `${String(ai.detected.ollama.models.length)} model(s): ${ai.detected.ollama.models.join(", ")}` : `not available — ${ai.detected.ollama.error ?? "unknown"}`}</dd>
              <dt>LocalAI</dt>
              <dd>{ai.detected.localai.available ? `${String(ai.detected.localai.models.length)} model(s): ${ai.detected.localai.models.join(", ")}` : `not available — ${ai.detected.localai.error ?? "unknown"}`}</dd>
            </dl>
            <p className="help">Install a model with e.g. <code>ollama pull llama3.2</code>. JARVIS never sends prompts, files, screenshots or clipboard contents anywhere but these local servers.</p>
          </>
        )}
        <button type="button" className="btn" onClick={() => void detect(true)} disabled={detectState.phase === "loading"}>
          {detectState.phase === "loading" ? "Checking…" : detectState.phase === "success" ? "Re-checked ✓" : "Check again"}
        </button>
      </section>
    </Dialog>
  );
}
