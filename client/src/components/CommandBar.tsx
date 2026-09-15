import { useEffect, useRef, useState } from "react";

import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useJarvis } from "../state/jarvisStore";

export function CommandBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useJarvis((s) => s.busy);
  const pending = useJarvis((s) => s.pendingPlan);
  const submitCommand = useJarvis((s) => s.submitCommand);
  const cancelCurrent = useJarvis((s) => s.cancelCurrent);
  const setOrb = useJarvis((s) => s.setOrb);

  const speech = useSpeechRecognition({
    onResult: (text) => {
      setValue(text);
      setOrb("idle");
      void submitCommand(text);
    },
    onStart: () => {
      setOrb("listening");
    },
    onEnd: () => {
      if (useJarvis.getState().orb === "listening") setOrb("idle");
    },
    onError: (msg) => {
      useJarvis.getState().addLog("error", msg);
      useJarvis.getState().flash("error", "MIC ERROR", 2000);
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // "/" focuses the command box from anywhere, Escape stops.
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
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
          placeholder={pending ? "Confirm or dismiss the plan above first" : "Ask JARVIS… e.g. “open youtube” or “create file notes.txt with hello”"}
          autoComplete="off"
          spellCheck={false}
          disabled={!!pending}
          maxLength={2000}
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
            disabled={busy || !!pending}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
            </svg>
          </button>
        )}

        {busy ? (
          <button type="button" className="btn btn-danger" onClick={() => void cancelCurrent()} aria-label="Stop the current task">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!value.trim() || !!pending}>
            Run
          </button>
        )}
      </form>
      <p className="hint">
        Press <kbd>/</kbd> to focus, <kbd>Enter</kbd> to run, <kbd>Esc</kbd> to stop.
      </p>
    </section>
  );
}
