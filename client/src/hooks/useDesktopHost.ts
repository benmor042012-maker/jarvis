import { useEffect } from "react";

import { alertSound } from "../lib/sound";
import { speak } from "../lib/speech";
import { desktopBridge, useJarvis } from "../state/jarvisStore";

/**
 * Inside the desktop window, sound and speech are requested by the agent
 * itself, so an alert still makes noise when the window is hidden in the tray.
 * Outside it (a phone, or a browser talking to a headless agent) the page
 * delivers them from the event stream instead — see onAlert in the store.
 */
export function useDesktopHost(): void {
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    const offSound = bridge.onAlertSound?.(() => {
      alertSound();
    });
    const offSpeak = bridge.onSpeak?.((text) => {
      const s = useJarvis.getState();
      if (s.voice?.muted || s.settings?.tts.enabled === false) return;
      void speak(text, s.settings?.tts.lang ?? (s.settings?.language === "en" ? "en-US" : "he-IL")).then((res) => {
        if (!res.spoken && res.reason && useJarvis.getState().ttsNote !== res.reason) {
          useJarvis.setState({ ttsNote: res.reason });
          s.addLog("warn", res.reason, res.fix ?? undefined);
        }
      });
    });
    return () => {
      offSound?.();
      offSpeak?.();
    };
  }, []);
}
