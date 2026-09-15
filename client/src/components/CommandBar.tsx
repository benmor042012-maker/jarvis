import { useEffect, useRef, useState } from "react";

import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useJarvis } from "../state/jarvisStore";

const EXAMPLES = ["open notepad", "צלם מסך", "create file notes.txt with hello", "remind me in 10 minutes to stretch", "what time is it"];

export function CommandBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useJarvis((s) => s.busy);
  const connection = useJarvis((s) => s.connection);
  const emergency = useJarvis((s) => s.status?.emergency ?? false);
  const pending = useJarvis((s) => s.pendingPlans.length > 0);
  const submitCommand = useJarvis((s) => s.submitCommand);
  const cancelCurrent = useJarvis((s) => s.cancelCurrent);
  const setOrb = useJarvis((s) => s.setOrb);
  const language = useJarvis((s) => s.settings?.language ?? "he");

  const speech = useSpeechRecognition({
    lang: language === "he" ? "he-IL" : "en-US",
    onResult: (text) => {
      setValue("");
      void submitCommand(text);
    },
    onStart: () => {
      setOrb("listening");
    },
    onEnd: () => {
      if (useJarvis.getState().orb === "listening") useJarvis.getState().setOrb("idle");
    },
    onError: (msg) => {
      useJarvis.getState().addLog("error", msg);
      useJarvis.getState().flash("error", "MIC ERROR", 2200);
    },
  });

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
          : `Ask JARVIS… e.g. “${EXAMPLES[Math.floor(Date.now() / 8000) % EXAMPLES.length] ?? EXAMPLES[0] ?? ""}”`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy || disabled) return;
    void submitCommand(value);
    setValue("");
  };

  return (
    <section className="command" aria-label="Command">
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
        {speech.supported && (
          <button
            type="button"
            className="icon-btn"
            aria-pressed={speech.listening}
            aria-label={speech.listening ? "Stop listening" : "Speak a command (asks for microphone permission)"}
            title={speech.listening ? "Stop listening" : "Speak a command"}
            onClick={() => {
              if (speech.listening) speech.stop();
              else void speech.start();
            }}
            disabled={busy || disabled}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
            </svg>
          </button>
        )}
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
        <kbd>/</kbd> focus · <kbd>Enter</kbd> run · <kbd>Esc</kbd> stop · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd> emergency stop (on the computer)
      </p>
    </section>
  );
}
