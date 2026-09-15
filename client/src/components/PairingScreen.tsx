import { useState } from "react";

import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";

/** Shown when this browser has no device identity yet (phones, other browsers). */
export function PairingScreen() {
  const pair = useJarvis((s) => s.pair);
  const connection = useJarvis((s) => s.connection);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName());
  const [run, state] = useAction(async () => {
    await pair(code, name.trim() || "device");
  });

  return (
    <div className="pairing">
      <div className="pairing-card">
        <h1>Pair this device</h1>
        <p>
          {connection === "unauthorized"
            ? "This device was revoked or its access expired. Pair it again with a new code."
            : "On the computer running JARVIS, open Devices → “Pair a new device” and type the 8-digit code here. The code works once and expires after 5 minutes."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label htmlFor="pair-code">Pairing code</label>
          <input id="pair-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d*" maxLength={8} value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 8)); }} placeholder="12345678" required />
          <label htmlFor="pair-name">Device name</label>
          <input id="pair-name" value={name} onChange={(e) => { setName(e.target.value.slice(0, 40)); }} maxLength={40} placeholder="My phone" />
          <button type="submit" className="btn btn-primary" disabled={code.length !== 8 || state.phase === "loading"}>
            {state.phase === "loading" ? "Pairing…" : "Pair"}
          </button>
        </form>
        {state.error && (
          <p role="alert" className="error-text">
            {state.error}
          </p>
        )}
        <p className="help">
          Nothing is sent outside your network: this page talks only to the JARVIS agent on your computer. If the computer is off, asleep or disconnected, pairing cannot work.
        </p>
      </div>
    </div>
  );
}

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac browser";
  if (/Windows/.test(ua)) return "Windows browser";
  return "Browser";
}
