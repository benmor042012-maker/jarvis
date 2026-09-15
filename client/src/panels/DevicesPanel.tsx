import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { DeviceInfo, PairCode } from "../types";

export function DevicesPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const creds = useJarvis((s) => s.creds);
  const unpair = useJarvis((s) => s.unpair);
  const liveDevices = useJarvis((s) => s.devices);
  const [loaded, setLoaded] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setLoaded((await api.devices()).devices);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(t); };
  }, [load]);

  // The event stream pushes the authoritative list; fall back to the fetch.
  const devices = liveDevices.length ? liveDevices : loaded;

  const [createCode, codeState] = useAction(async () => {
    const c = await api.pairCode();
    setPairCode(c);
    const url = c.urls.find((u) => !u.includes("127.0.0.1")) ?? c.urls[0] ?? "";
    try {
      setQr(await QRCode.toDataURL(`${url}#code=${c.code}`, { margin: 1, width: 220, color: { dark: "#eaf6ff", light: "#00000000" } }));
    } catch {
      setQr(null);
    }
  });

  const [revoke, revokeState] = useAction(async (id: string) => {
    await api.revokeDevice(id);
    await load();
  });

  const isOwner = creds?.role === "owner";
  const codeLeft = pairCode ? Math.max(0, Math.round((pairCode.expires_at - now) / 1000)) : 0;

  return (
    <Dialog title="Devices" onClose={() => { setPanel(null); }} wide>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {isOwner ? (
        <section>
          <h3>Pair a new device</h3>
          <p className="help">A phone on the same Wi-Fi opens the address below and types the code. The code is single use and expires in 5 minutes. For LAN access, enable it in Settings first.</p>
          <button type="button" className="btn btn-primary" onClick={() => void createCode()} disabled={codeState.phase === "loading"}>
            {codeState.phase === "loading" ? "Creating…" : "Create pairing code"}
          </button>
          {codeState.error && (
            <p role="alert" className="error-text">
              {codeState.error}
            </p>
          )}
          {pairCode && (
            <div className="pair-code">
              {codeLeft > 0 ? (
                <>
                  <output className="code">{pairCode.code}</output>
                  <p className="help">Expires in {codeLeft}s. Open one of: {pairCode.urls.join(" · ")}</p>
                  {qr && <img src={qr} alt="QR code containing the JARVIS address and pairing code" width={220} height={220} />}
                </>
              ) : (
                <p className="help">That code expired. Create another one.</p>
              )}
            </div>
          )}
        </section>
      ) : (
        <p className="help">Only the JARVIS computer can pair new devices. This device can rename or revoke itself.</p>
      )}

      <section>
        <h3>Paired devices</h3>
        {devices.length === 0 ? (
          <p className="log-empty">No devices yet.</p>
        ) : (
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id} className="list-item">
                <div>
                  <strong>
                    {d.name} {d.id === creds?.id && <span className="pill pill-model">this device</span>}
                  </strong>
                  <span className="help">
                    {d.role} · {d.revoked ? "REVOKED" : d.online ? "online" : d.last_seen ? `last seen ${new Date(d.last_seen).toLocaleString()}` : "never connected"} ·{" "}
                    {d.expires_at ? `expires ${new Date(d.expires_at).toLocaleDateString()}` : "no expiry"} {d.last_ip ? `· ${d.last_ip}` : ""}
                  </span>
                </div>
                {!d.revoked && (isOwner || d.id === creds?.id) && (
                  <button type="button" className="btn btn-danger" onClick={() => void (d.id === creds?.id ? unpair() : revoke(d.id))} disabled={revokeState.phase === "loading"}>
                    {d.id === creds?.id ? "Revoke this device" : "Revoke"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revokeState.error && (
          <p role="alert" className="error-text">
            {revokeState.error}
          </p>
        )}
      </section>
    </Dialog>
  );
}
