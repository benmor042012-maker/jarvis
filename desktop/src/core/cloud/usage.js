// What has actually left this computer since JARVIS started — counted where it
// happens, so the status screen reports a number rather than a promise.
const usage = { groqCalls: 0, groqLastError: null, groqLastAt: null, webhookSends: 0, webhookLastAt: null };

function groqCall(error = null) {
  usage.groqCalls += 1;
  usage.groqLastAt = Date.now();
  usage.groqLastError = error;
}

function webhookSent() {
  usage.webhookSends += 1;
  usage.webhookLastAt = Date.now();
}

function snapshot() {
  return { ...usage };
}

function reset() {
  Object.assign(usage, { groqCalls: 0, groqLastError: null, groqLastAt: null, webhookSends: 0, webhookLastAt: null });
}

module.exports = { groqCall, webhookSent, snapshot, reset };
