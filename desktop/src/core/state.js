// Agent state machine. One source of truth for the tray, the UI and the API.
//   offline | connected | listening | busy | paused | emergency_stopped
const EventEmitter = require("events");

class AgentState extends EventEmitter {
  constructor() {
    super();
    this.state = "connected";
    this.emergency = false;
    this.paused = false;
    this.busyCount = 0;
    this.listening = false;
    this.lastChange = Date.now();
    this.startedAt = Date.now();
  }

  compute() {
    if (this.emergency) return "emergency_stopped";
    if (this.paused) return "paused";
    if (this.busyCount > 0) return "busy";
    if (this.listening) return "listening";
    return "connected";
  }

  _refresh(reason) {
    const next = this.compute();
    if (next !== this.state) {
      this.state = next;
      this.lastChange = Date.now();
      this.emit("change", { state: next, reason });
    }
  }

  beginBusy() { this.busyCount++; this._refresh("busy"); }
  endBusy() { this.busyCount = Math.max(0, this.busyCount - 1); this._refresh("idle"); }
  setListening(on) { this.listening = !!on; this._refresh("listening"); }
  setPaused(on) { this.paused = !!on; this._refresh("paused"); }
  emergencyStop(source) { this.emergency = true; this.busyCount = 0; this._refresh(`emergency:${source}`); }
  clearEmergency() { this.emergency = false; this._refresh("emergency_cleared"); }

  view() {
    return { state: this.state, emergency: this.emergency, paused: this.paused, busy: this.busyCount > 0, since: this.lastChange, uptime_ms: Date.now() - this.startedAt };
  }
}

module.exports = { AgentState };
