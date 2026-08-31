// Voice state + TTS.
//
// Speech recognition does NOT live here. Stock Electron ships without Google's
// speech service keys, so webkitSpeechRecognition fails immediately inside the
// app. Hebrew recognition works in real Chrome, so the Chrome tab listens and
// posts the recognized command to the local bridge (src/bridge.js). This class
// keeps the state machine the tray and UI display, and speaks replies.

const EventEmitter = require("events");

class VoiceService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = "stopped";
    this.window = null;
  }

  getState() { return this.state; }

  _set(state) {
    this.state = state;
    this.emit("state", state);
  }

  start(window) {
    if (window) this.window = window;
    this._set("listening");
  }

  stop() { this._set("stopped"); }
  pause() { this._set("paused"); }
  resume() { if (this.state === "paused") this._set("listening"); }
  doneProcessing() { this._set("listening"); }

  // Called when a command arrives from the Chrome tab via the bridge.
  commandReceived(text) {
    this._set("processing");
    this.emit("command", text);
  }

  speak(window, text) {
    const win = window || this.window;
    if (!win?.webContents || !text) return;
    // Pass the text as an argument rather than interpolating it into source.
    win.webContents
      .executeJavaScript(
        `(() => { try {
           speechSynthesis.cancel();
           const u = new SpeechSynthesisUtterance(${JSON.stringify(text)});
           u.lang = ${JSON.stringify(this.config.ttsLang || "he-IL")};
           u.rate = 1.05;
           speechSynthesis.speak(u);
         } catch {} })();`
      )
      .catch(() => {});
  }
}

module.exports = { VoiceService };
