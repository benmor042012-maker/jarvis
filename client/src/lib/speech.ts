// Speaking out loud, using only voices installed on this computer.
//
// The browser's speech synthesis can expose network voices (Chrome ships a few
// that are synthesised on Google's servers). Those are excluded on purpose:
// every voice used here has localService === true, so the text never leaves the
// machine. If no local voice exists for the language, JARVIS says so and stays
// silent rather than reading Hebrew with an English voice.

export interface VoicePick {
  voice: SpeechSynthesisVoice | null;
  reason: string | null;
  fix: string | null;
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function pickVoice(lang: string): VoicePick {
  if (!speechAvailable()) return { voice: null, reason: "This browser has no speech synthesis, so JARVIS cannot speak here.", fix: "Open the JARVIS page in Chrome or Edge." };
  const wanted = lang.toLowerCase().slice(0, 2);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return { voice: null, reason: "The list of installed voices is not ready yet.", fix: null };
  const local = voices.filter((v) => v.localService);
  const match = local.find((v) => v.lang.toLowerCase().startsWith(wanted)) ?? null;
  if (match) return { voice: match, reason: null, fix: null };
  if (voices.some((v) => v.lang.toLowerCase().startsWith(wanted))) {
    return {
      voice: null,
      reason: `The only "${wanted}" voice this browser offers is synthesised on a remote server, and JARVIS never sends your text off this computer.`,
      fix: "Install a local voice: Windows Settings → Time & language → Speech → Manage voices → Add voices.",
    };
  }
  return {
    voice: null,
    reason: `No voice for "${wanted}" is installed on this computer, so JARVIS cannot speak that language out loud.`,
    fix: "Windows Settings → Time & language → Language & region → Add a language → choose the language → Language options → Speech. It is free and part of Windows.",
  };
}

/** Speak, resolving when the speech finishes (or immediately if it cannot). */
export function speak(text: string, lang: string): Promise<{ spoken: boolean; reason: string | null; fix: string | null }> {
  return new Promise((resolve) => {
    const clean = text.trim();
    if (!clean) {
      resolve({ spoken: false, reason: null, fix: null });
      return;
    }
    const pick = pickVoice(lang);
    if (!pick.voice) {
      resolve({ spoken: false, reason: pick.reason, fix: pick.fix });
      return;
    }
    const u = new SpeechSynthesisUtterance(clean.slice(0, 600));
    u.voice = pick.voice;
    u.lang = pick.voice.lang;
    u.rate = 1;
    let done = false;
    const finish = (spoken: boolean, reason: string | null) => {
      if (done) return;
      done = true;
      resolve({ spoken, reason, fix: null });
    };
    u.onend = () => {
      finish(true, null);
    };
    u.onerror = (e) => {
      finish(false, `Speaking failed (${e.error}).`);
    };
    window.speechSynthesis.speak(u);
    // Some builds never fire onend; do not leave the UI stuck on SPEAKING.
    window.setTimeout(() => {
      finish(true, null);
    }, Math.min(30000, 2000 + clean.length * 90));
  });
}

export function stopSpeaking(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
}

/** Voice lists load asynchronously in Chrome; wait once for them. */
export function warmVoices(): void {
  if (!speechAvailable()) return;
  window.speechSynthesis.getVoices();
}
