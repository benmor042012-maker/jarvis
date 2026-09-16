import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typing for the Web Speech API (not in lib.dom for every TS version).
interface SpeechRecognitionResultLike {
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Why speech is unavailable here, or null when it works.
 *
 * The constructor exists inside the JARVIS desktop window but always fails:
 * stock Electron ships without the speech service the API depends on, so it
 * aborts with a misleading "network" error. Rather than offer a button that
 * can only fail, say what actually works — the same UI in Chrome or Edge.
 */
export function speechUnavailableReason(): string | null {
  const isDesktopWindow = "jarvisDesktop" in window;
  if (isDesktopWindow) return "Voice input does not work inside the JARVIS window: Electron has no speech recognition service. Open this same page in Chrome or Edge (http://127.0.0.1:8765) to talk to JARVIS.";
  if (getCtor() === null) return "This browser has no speech recognition. Chrome and Edge support it; Firefox and Safari do not.";
  return null;
}

interface Options {
  lang?: string;
  onResult: (text: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone permission was denied. Allow it in the browser to use voice.",
  "service-not-allowed": "Speech recognition is not available in this browser.",
  "no-speech": "I didn't hear anything.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition could not reach the browser's speech service. In Chrome/Edge this usually means no internet; JARVIS itself keeps working offline — type instead.",
};

/**
 * Browser speech recognition. Nothing is captured until the user explicitly
 * calls start(); the browser then shows its own permission prompt.
 */
export function useSpeechRecognition({ lang = "en-US", onResult, onStart, onEnd, onError }: Options) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const unavailable = typeof window === "undefined" ? "Not a browser." : speechUnavailableReason();
  const supported = unavailable === null;

  const cbs = useRef({ onResult, onStart, onEnd, onError });
  useEffect(() => {
    cbs.current = { onResult, onStart, onEnd, onError };
  });

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    const Ctor = getCtor();
    if (!Ctor) return;
    // Explicit permission first, so the user sees exactly what is being asked.
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => {
          t.stop();
        });
      }
    } catch {
      cbs.current.onError?.(ERRORS["not-allowed"] ?? "Microphone permission was denied.");
      return;
    }
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onstart = () => {
      setListening(true);
      cbs.current.onStart?.();
    };
    rec.onresult = (e) => {
      const text = e.results[0]?.[0].transcript.trim();
      if (text) cbs.current.onResult(text);
    };
    rec.onerror = (e) => {
      cbs.current.onError?.(ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      cbs.current.onEnd?.();
    };
    recRef.current = rec;
    rec.start();
  }, [lang]);

  useEffect(
    () => () => {
      recRef.current?.abort();
    },
    [],
  );

  return { supported, unavailable, listening, start, stop };
}
