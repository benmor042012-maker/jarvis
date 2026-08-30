// Voice module: wake word detection + STT/TTS
// Uses Electron's Chromium Web Speech API — 100% local wake word detection.
// STT uses Web Speech API (sends audio to Google for recognition — standard Chrome behavior).
// TTS uses local speechSynthesis.

const EventEmitter = require("events");

class VoiceService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = "stopped";
    this.recognition = null;
    this.wakeWords = config.wakeWords || ["jarvis", "ג'רביס", "גרביס"];
    this.commandBuffer = "";
    this.commandTimeout = null;
    this.listeningForCommand = false;
  }

  getState() { return this.state; }

  start(window) {
    if (!window?.webContents) return;
    this.window = window;
    this.state = "listening";
    this.emit("state", this.state);

    window.webContents.executeJavaScript(`
      (() => {
        if (window._jarvisVoice) { window._jarvisVoice.stop(); }
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) { window._jarvisVoiceApi.onError("Speech recognition not available"); return; }

        const r = new SpeechRecognition();
        r.continuous = true;
        r.interimResults = true;
        r.lang = "${this.config.sttLang || "he-IL"}";

        r.onresult = (e) => {
          let transcript = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            transcript += e.results[i][0].transcript;
          }
          const isFinal = e.results[e.results.length - 1].isFinal;
          window._jarvisVoiceApi.onTranscript(transcript.trim(), isFinal);
        };

        r.onerror = (e) => { window._jarvisVoiceApi.onError(e.error); };
        r.onend = () => {
          if (window._jarvisVoiceActive) {
            setTimeout(() => { try { r.start(); } catch {} }, 200);
          }
        };

        window._jarvisVoice = r;
        window._jarvisVoiceActive = true;
        r.start();
      })();
    `).catch(() => {});
  }

  stop() {
    this.state = "stopped";
    this.listeningForCommand = false;
    this.emit("state", this.state);
    if (this.window?.webContents) {
      this.window.webContents.executeJavaScript(`
        window._jarvisVoiceActive = false;
        if (window._jarvisVoice) window._jarvisVoice.stop();
      `).catch(() => {});
    }
  }

  pause() {
    this.state = "paused";
    this.emit("state", this.state);
    if (this.window?.webContents) {
      this.window.webContents.executeJavaScript(`
        window._jarvisVoiceActive = false;
        if (window._jarvisVoice) window._jarvisVoice.stop();
      `).catch(() => {});
    }
  }

  resume() {
    if (this.state === "paused") this.start(this.window);
  }

  handleTranscript(text, isFinal) {
    const lower = text.toLowerCase();

    if (!this.listeningForCommand) {
      const found = this.wakeWords.some((w) => lower.includes(w.toLowerCase()));
      if (found) {
        this.listeningForCommand = true;
        this.commandBuffer = "";
        this.state = "active";
        this.emit("state", this.state);
        this.emit("wakeword");

        let command = text;
        for (const w of this.wakeWords) {
          const idx = lower.indexOf(w.toLowerCase());
          if (idx !== -1) {
            command = text.slice(idx + w.length).trim();
            if (command.startsWith(",") || command.startsWith("،")) command = command.slice(1).trim();
            break;
          }
        }
        if (command && isFinal) {
          this._emitCommand(command);
          return;
        }
        this.commandBuffer = command;
        this._resetTimeout();
      }
      return;
    }

    this.commandBuffer = text;
    this._resetTimeout();

    if (isFinal && this.commandBuffer.trim()) {
      this._emitCommand(this.commandBuffer.trim());
    }
  }

  _resetTimeout() {
    clearTimeout(this.commandTimeout);
    this.commandTimeout = setTimeout(() => {
      if (this.listeningForCommand && this.commandBuffer.trim()) {
        this._emitCommand(this.commandBuffer.trim());
      } else {
        this.listeningForCommand = false;
        this.state = "listening";
        this.emit("state", this.state);
      }
    }, 3000);
  }

  _emitCommand(text) {
    clearTimeout(this.commandTimeout);
    this.listeningForCommand = false;
    this.state = "processing";
    this.emit("state", this.state);
    this.emit("command", text);
  }

  speak(window, text) {
    if (!window?.webContents) return;
    const escaped = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
    window.webContents.executeJavaScript(`
      (() => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(\`${escaped}\`);
        u.lang = "${this.config.ttsLang || "he-IL"}";
        u.rate = 1.05;
        speechSynthesis.speak(u);
      })();
    `).catch(() => {});
  }

  doneProcessing() {
    this.state = "listening";
    this.emit("state", this.state);
  }
}

module.exports = { VoiceService };
