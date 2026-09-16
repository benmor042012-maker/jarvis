// Phone calls, and the honest limits of doing them without a paid service.
//
// What is genuinely possible with only this computer, your phone and your own
// Wi-Fi:
//   • The computer can alert the phone over the local network.
//   • The phone (with the JARVIS page open) can show a full-screen alert and,
//     after you approve it, open the dialer with the number already filled in.
//     You still press the call button — that is the last step Android gives a
//     web page, and it is also the step that keeps a wrong number from ringing.
//
// What is NOT possible here, and is therefore disabled rather than faked:
//   • Placing a call by itself. A web page cannot dial; only a native Android
//     app with CALL_PHONE can, and no such app ships with JARVIS.
//   • Answering an incoming call for you. That needs ANSWER_PHONE_CALLS
//     (Android 8+) or an accessibility service in a native app — again, not
//     something a web page can ever do.
//   • A cellular call from the computer itself. There is no modem and no
//     carrier, and a VoIP provider would be a paid external service.
//
// The computer never learns whether a call connected: Android does not tell a
// web page. So JARVIS records only what the phone confirms — "the dialer was
// opened" — and asks you for the outcome. It never shows "connected" or
// "answered for you".
const EventEmitter = require("events");

const audit = require("./audit");
const { uuid, nowMs, sha256 } = require("./util");

const REQUEST_TTL_MS = 5 * 60 * 1000;

const CAPABILITIES = {
  place_call_from_computer: {
    available: false,
    why: "This computer has no cellular modem and no carrier connection, and a VoIP service would be a paid external provider.",
    one_time_step: null,
  },
  open_dialer_on_phone: {
    available: true,
    requires: "A paired phone on your Wi-Fi with the JARVIS page open.",
    why: "Android lets a web page hand a number to the dialer (a tel: link). You press the call button.",
    one_time_step: "Pair the phone once (Devices → Pair a new device) and keep the JARVIS page open, or install it to the home screen.",
  },
  auto_dial_without_pressing: {
    available: false,
    why: "A web page may open the dialer but may never press call — Android reserves that for the user, and every browser enforces it.",
    one_time_step: "Would require a native Android app holding the CALL_PHONE permission. JARVIS does not ship one, and installing an unsigned APK is not something it will ask you to do.",
  },
  answer_incoming_call: {
    available: false,
    why: "Answering a call needs the ANSWER_PHONE_CALLS permission (Android 8+) or an accessibility service, both of which only a native app can hold. A web page has no telephony access at all.",
    one_time_step: "Would require a native Android companion app, granted by you in Android Settings → Apps → Special access. JARVIS does not ship one; the alert plus one-tap dialer is what it does instead.",
  },
  answer_from_computer_over_bluetooth: {
    available: false,
    why: "Windows can answer a paired phone's call over Bluetooth hands-free, but only through Phone Link's own interface. Driving that from JARVIS would mean automating another app's window, which is exactly the kind of unofficial automation this project refuses.",
    one_time_step: "Use Phone Link yourself if you want that; JARVIS will not pretend to do it.",
  },
  record_call_audio: {
    available: false,
    why: "Call audio is never recorded or stored. Android blocks it for apps anyway, and JARVIS does not want it.",
    one_time_step: null,
  },
};

function maskNumber(n) {
  const digits = String(n || "").replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

/** Accept only a plain phone number; never a URL, never a shell string. */
function normalizeNumber(raw) {
  const s = String(raw || "").trim();
  if (!/^[+0-9 ()\-.]{6,25}$/.test(s)) throw Object.assign(new Error("That does not look like a phone number."), { status: 400 });
  const digits = s.replace(/[^\d+]/g, "");
  if (!/^\+?\d{6,15}$/.test(digits)) throw Object.assign(new Error("That does not look like a phone number."), { status: 400 });
  return digits;
}

class Phone extends EventEmitter {
  constructor({ getConfig, host = {} }) {
    super();
    this.getConfig = getConfig;
    this.host = host;
    this.requests = new Map();
  }

  cfg() {
    return this.getConfig().phone || {};
  }

  /** What this setup can and cannot do, with the reason for each. */
  capabilities({ devices = [] } = {}) {
    const phones = devices.filter((d) => !d.revoked && /phone|android|iphone|ipad|mobile/i.test(`${d.name} ${d.user || ""}`));
    const online = phones.filter((d) => d.online);
    const caps = JSON.parse(JSON.stringify(CAPABILITIES));
    caps.open_dialer_on_phone.available = online.length > 0;
    if (!online.length) {
      caps.open_dialer_on_phone.blocked_because = phones.length
        ? "A phone is paired but not connected right now. Open the JARVIS page on it, on the same Wi-Fi."
        : "No phone is paired yet.";
    }
    return {
      capabilities: caps,
      phones: phones.map((d) => ({ id: d.id, name: d.name, online: d.online, last_seen: d.last_seen })),
      simulation_enabled: this.cfg().simulation !== false,
      answering_enabled: false,
      summary: online.length
        ? "JARVIS can alert your phone and, after you approve, open the dialer with the number ready. You press call."
        : "No phone is connected, so JARVIS can only show the call on this computer. Pair a phone and keep its JARVIS page open.",
    };
  }

  /**
   * Ask to call a number. Nothing happens until it is approved, and even then
   * the phone only opens its dialer.
   */
  request({ to, reason, customer_id = null, simulate = false }, { device, devices = [] } = {}) {
    const number = normalizeNumber(to);
    const cfg = this.getConfig();
    if (!cfg.phone?.enabled) throw Object.assign(new Error("Phone calling is switched off in Settings."), { status: 403 });
    const caps = this.capabilities({ devices });
    const sim = simulate || cfg.phone.simulation === true || !caps.capabilities.open_dialer_on_phone.available;

    const req = {
      id: uuid(),
      created_at: nowMs(),
      expires_at: nowMs() + REQUEST_TTL_MS,
      number,
      number_masked: maskNumber(number),
      reason: String(reason || "").slice(0, 400),
      customer_id,
      // "simulation" means: the workflow runs end to end, the dialer is never
      // opened, and every screen says so.
      simulation: sim,
      simulation_because: sim ? (cfg.phone.simulation === true ? "Simulation is on in Settings." : caps.capabilities.open_dialer_on_phone.blocked_because || "No phone is connected.") : null,
      status: "pending_approval",
      approved_by: null,
      approved_at: null,
      dialer_opened_at: null,
      dialer_device: null,
      outcome: null,
      outcome_note: "",
      transcript: [],
      draft: "",
      requested_by: device?.name || "JARVIS",
      hash: sha256(`${number}|${reason || ""}|${customer_id || ""}`),
    };
    this.requests.set(req.id, req);
    for (const [id, r] of this.requests) if (r.expires_at < nowMs() - 3600000) this.requests.delete(id);
    audit.log({ event: "call_requested", device: device?.name, detail: { number: req.number_masked, simulation: sim, customer_id } });
    this.emit("event", { type: "call", call: this.view(req) });
    return this.view(req);
  }

  view(req) {
    // The full number is shown on the approval screen (you must see what will
    // be dialled); everywhere else it is masked.
    const { number, ...rest } = req;
    return { ...rest, number, number_masked: req.number_masked };
  }

  get(id) {
    const r = this.requests.get(id);
    if (!r) return null;
    if (r.status === "pending_approval" && r.expires_at < nowMs()) r.status = "expired";
    return r;
  }

  /** Approve or reject. Approval is bound to the exact number and reason. */
  decide(id, { decision, hash, device }) {
    const req = this.get(id);
    if (!req) throw Object.assign(new Error("Unknown call request."), { status: 404 });
    if (req.status === "expired") throw Object.assign(new Error("That call request expired."), { status: 410 });
    if (req.status !== "pending_approval") throw Object.assign(new Error(`This request is already ${req.status}.`), { status: 409 });
    if (hash !== req.hash) throw Object.assign(new Error("The approval does not match the number that was shown."), { status: 400, code: "modified" });

    if (decision !== "approve") {
      req.status = "rejected";
      audit.log({ event: "call_rejected", device: device?.name, detail: { number: req.number_masked } });
      this.emit("event", { type: "call", call: this.view(req) });
      return this.view(req);
    }
    req.status = req.simulation ? "simulated" : "approved";
    req.approved_by = device?.name || null;
    req.approved_at = nowMs();
    if (req.simulation) {
      req.outcome = "simulated";
      req.outcome_note = "Simulation: no number was dialled and no call was placed.";
    }
    audit.log({ event: req.simulation ? "call_simulated" : "call_approved", device: device?.name, detail: { number: req.number_masked } });
    this.emit("event", { type: "call", call: this.view(req) });
    return this.view(req);
  }

  /** The phone tells us it opened its dialer. That is all it can tell us. */
  dialerOpened(id, { device } = {}) {
    const req = this.get(id);
    if (!req) throw Object.assign(new Error("Unknown call request."), { status: 404 });
    if (req.status !== "approved") throw Object.assign(new Error("That call was not approved."), { status: 409 });
    req.status = "dialer_opened";
    req.dialer_opened_at = nowMs();
    req.dialer_device = device?.name || null;
    req.outcome = "unknown";
    req.outcome_note = "The phone opened the dialer. Android does not tell a web page whether the call was then placed or answered, so JARVIS does not know — tell it below.";
    audit.log({ event: "call_dialer_opened", device: device?.name, detail: { number: req.number_masked } });
    this.emit("event", { type: "call", call: this.view(req) });
    return this.view(req);
  }

  /** You tell JARVIS what actually happened. It never guesses. */
  setOutcome(id, { outcome, note, device } = {}) {
    const req = this.get(id);
    if (!req) throw Object.assign(new Error("Unknown call request."), { status: 404 });
    const allowed = ["answered", "no_answer", "busy", "wrong_number", "cancelled", "unknown"];
    if (!allowed.includes(outcome)) throw Object.assign(new Error(`outcome must be one of ${allowed.join(", ")}`), { status: 400 });
    req.outcome = outcome;
    req.outcome_note = String(note || "").slice(0, 1000);
    req.status = "closed";
    audit.log({ event: "call_outcome", device: device?.name, detail: { number: req.number_masked, outcome, reported_by: "user" } });
    this.emit("event", { type: "call", call: this.view(req) });
    return this.view(req);
  }

  /** Stop a call request in flight. Also used by the emergency stop. */
  stop(id, { device, reason = "user" } = {}) {
    const req = this.get(id);
    if (!req) return null;
    if (["closed", "rejected", "expired"].includes(req.status)) return this.view(req);
    req.status = "stopped";
    req.outcome = req.outcome || "cancelled";
    req.outcome_note = "Stopped before completing.";
    audit.log({ event: "call_stopped", device: device?.name, detail: { number: req.number_masked, reason } });
    this.emit("event", { type: "call", call: this.view(req) });
    return this.view(req);
  }

  stopAll(reason = "emergency_stop") {
    let n = 0;
    for (const req of this.requests.values()) {
      if (["pending_approval", "approved", "dialer_opened"].includes(req.status)) {
        this.stop(req.id, { reason });
        n++;
      }
    }
    return n;
  }

  /** Notes you dictate or type during/after a call. Text only, never audio. */
  addTranscript(id, { text, speaker = "me", device } = {}) {
    const req = this.get(id);
    if (!req) throw Object.assign(new Error("Unknown call request."), { status: 404 });
    const line = { at: nowMs(), speaker: speaker === "them" ? "them" : "me", text: String(text || "").slice(0, 2000) };
    if (!line.text.trim()) throw Object.assign(new Error("Nothing to add."), { status: 400 });
    req.transcript.push(line);
    if (req.transcript.length > 300) req.transcript.splice(0, req.transcript.length - 300);
    audit.log({ event: "call_note_added", device: device?.name, detail: { call: id, chars: line.text.length } });
    return this.view(req);
  }

  setDraft(id, text) {
    const req = this.get(id);
    if (!req) throw Object.assign(new Error("Unknown call request."), { status: 404 });
    req.draft = String(text || "").slice(0, 4000);
    return this.view(req);
  }

  list() {
    return [...this.requests.values()].map((r) => this.view(r)).sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Answering on your behalf. Always refused, with the reason and the step it
   * would take — never silently disabled and never faked.
   */
  answerIncoming() {
    const cap = CAPABILITIES.answer_incoming_call;
    const e = new Error(cap.why);
    e.status = 501;
    e.code = "answering_not_possible";
    e.detail = `${cap.why} ${cap.one_time_step}`;
    throw e;
  }
}

module.exports = { Phone, CAPABILITIES, normalizeNumber, maskNumber, REQUEST_TTL_MS };
