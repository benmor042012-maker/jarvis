import { useEffect, useRef, useState } from "react";

import { useJarvis } from "../state/jarvisStore";

const EXAMPLES = ["open notepad", "צלם מסך", "create file notes.txt with hello", "remind me in 10 minutes to stretch", "what time is it"];

/**
 * The keyboard fallback. JARVIS is controlled by voice; this stays hidden until
 * it is asked for, and exists because a keyboard still has to work when no
 * speech engine is installed, in a noisy room, or for anyone who cannot speak.
 */
export function CommandBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useJarvis((s) => s.busy);
  const connection = useJarvis((s) => s.connection);
  const emergency = useJarvis((s) => s.status?.emergency ?? false);
  const pending = useJarvis((s) => s.pendingPlans.length > 0);
  const submitCommand = useJarvis((s) => s.submitCommand);
  const cancelCurrent = useJarvis((s) => s.cancelCurrent);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && busy) void cancelCurrent();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [busy, cancelCurrent]);

  const disabled = connection !== "online" || emergency;
  const placeholder = emergency
    ? "Emergency stop is active — clear it on the computer first"
    : connection === "offline"
      ? "Agent offline — the computer cannot be controlled right now"
      : connection === "unpaired"
        ? "Pair this device first"
        : pending
          ? "An approval is waiting — answer it first"
          : `Type a command… e.g. “${EXAMPLES[Math.floor(Date.now() / 8000) % EXAMPLES.length] ?? EXAMPLES[0] ?? ""}”`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy || disabled) return;
    void submitCommand(value);
    setValue("");
  };

  return (
    <div className="command" aria-label="Keyboard fallback">
      <form className="command-form" onSubmit={submit}>
        <label htmlFor="command-input" className="sr-only">
          Command for JARVIS
        </label>
        <input
          id="command-input"
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          maxLength={4000}
        />
        {busy ? (
          <button type="button" className="btn btn-danger" onClick={() => void cancelCurrent()} aria-label="Stop the current task">
            Stop task
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!value.trim() || disabled}>
            Run
          </button>
        )}
      </form>
      <p className="hint">
        <kbd>Enter</kbd> run · <kbd>Esc</kbd> stop · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd> emergency stop (on the computer)
      </p>
    </div>
  );
}
