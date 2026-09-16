import { useState } from "react";

import type { SpeechEngineInstall } from "../types";

/**
 * The exact free steps for a missing local component. Nothing here costs money,
 * needs an account, or sends anything anywhere — the downloads are the engine
 * and the model files themselves.
 */
export function InstallSteps({ install, title }: { install: SpeechEngineInstall; title?: string }) {
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const [copied, setCopied] = useState<string | null>(null);
  const steps = isWindows ? install.windows : install.other;
  const other = isWindows ? install.other : install.windows;

  const copy = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(text);
        window.setTimeout(() => {
          setCopied(null);
        }, 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="install">
      <h4>{title ?? `Missing: ${install.what}`}</h4>
      <ol className="install-steps">
        {steps.map((step, i) => (
          <li key={i}>
            <span>{step}</span>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => { copy(step); }} title="Copy this step">
              {copied === step ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ol>
      {install.note && <p className="help">{install.note}</p>}
      <details>
        <summary>Steps for the other platforms</summary>
        <ol className="install-steps">
          {other.map((step, i) => (
            <li key={i}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </details>
      <p className="help">Free, offline after the download, no account and no key. JARVIS never downloads any of this by itself.</p>
    </div>
  );
}
