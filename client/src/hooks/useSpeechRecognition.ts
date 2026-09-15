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
  network: "Speech recognition needs a network connection in this browser.",
};

/**
 * Browser speech recognition. Nothing is captured until the user explicitly
 * calls start(); the browser then shows its own permission prompt.
 */
export function useSpeechRecognition({ lang = "en-US", onResult, onStart, onEnd, onError }: Options) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = typeof window !== "undefined" && getCtor() !== null;

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

  return { supported, listening, start, stop };
}
