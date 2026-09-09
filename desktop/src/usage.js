// Tracks what JARVIS spends on the Claude API and enforces a local monthly
// ceiling. The numbers are estimates from the public per-token prices; the
// authoritative bill is the Anthropic console.

const fs = require("fs");
const path = require("path");
const { JARVIS_HOME } = require("./config");

const USAGE_PATH = path.join(JARVIS_HOME, "usage.json");

// USD per million tokens: [input, output]. Cache reads are ~0.1x input,
// cache writes ~1.25x input.
const PRICES = {
  free: [0, 0], // Cloudflare Workers AI within the free daily allowance
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
const DEFAULT_PRICE = [5, 25];
const USD_TO_ILS = 3.7; // rough; shown as an approximation only

function priceFor(model) {
  return PRICES[model] || DEFAULT_PRICE;
}

// Returns USD for one response's usage object.
function costOf(model, usage) {
  if (!usage) return 0;
  const [inP, outP] = priceFor(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (inTok * inP + cacheRead * inP * 0.1 + cacheWrite * inP * 1.25 + outTok * outP) / 1e6
  );
}

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
  fs.writeFileSync(USAGE_PATH, JSON.stringify(all, null, 2), "utf8");
}

function thisMonth() {
  const all = loadAll();
  return all[monthKey()] || { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

function record(model, usage) {
  const usd = costOf(model, usage);
  const all = loadAll();
  const k = monthKey();
  const m = all[k] || { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  m.usd += usd;
  m.calls += 1;
  m.inputTokens += (usage && usage.input_tokens) || 0;
  m.outputTokens += (usage && usage.output_tokens) || 0;
  m.cacheReadTokens += (usage && usage.cache_read_input_tokens) || 0;
  all[k] = m;
  try { saveAll(all); } catch {}
  return usd;
}

function overCap(capUSD) {
  if (!capUSD || capUSD <= 0) return false;
  return thisMonth().usd >= capUSD;
}

function fmt(usd) {
  const ils = usd * USD_TO_ILS;
  if (usd < 0.01) return `<0.01$ (≈${ils.toFixed(2)}₪)`;
  return `${usd.toFixed(2)}$ (≈${ils.toFixed(1)}₪)`;
}

module.exports = { costOf, record, thisMonth, overCap, fmt, priceFor, USD_TO_ILS, USAGE_PATH };
