const https = require("https");
const http = require("http");
const { URL } = require("url");

function httpGet(url, maxLen = 200000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, maxLen).then(resolve, reject);
      }
      let data = "";
      res.on("data", (c) => {
        data += c;
        if (data.length > maxLen) { res.destroy(); resolve(data.slice(0, maxLen)); }
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}

const PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|localhost|::1|\[::1\])/i;

async function web_search({ query, lang }) {
  const q = encodeURIComponent(query);
  const html = await httpGet(`https://html.duckduckgo.com/html/?q=${q}&kl=${lang || "he-il"}`);
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    const url = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1]);
    results.push({
      title: m[2].replace(/<[^>]+>/g, "").trim(),
      url,
      snippet: m[3].replace(/<[^>]+>/g, "").trim(),
    });
  }
  return results.length ? JSON.stringify(results) : "No results found.";
}

async function web_fetch({ url }) {
  const u = new URL(url);
  if (PRIVATE_RE.test(u.hostname)) throw new Error("Access to private/local addresses is blocked.");
  const html = await httpGet(url);
  return stripHtml(html);
}

async function weather({ location }) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=he`;
  const geo = JSON.parse(await httpGet(geoUrl, 10000));
  if (!geo.results?.length) return `Location "${location}" not found.`;
  const { latitude, longitude, name } = geo.results[0];
  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&hourly=temperature_2m,weather_code&timezone=Asia/Jerusalem&forecast_hours=24`;
  const wx = JSON.parse(await httpGet(wxUrl, 30000));
  const c = wx.current;
  const codes = { 0: "בהיר", 1: "בהיר בעיקר", 2: "מעונן חלקית", 3: "מעונן", 45: "ערפל", 51: "טפטוף", 61: "גשם", 71: "שלג", 80: "ממטר", 95: "סופת רעמים" };
  return JSON.stringify({
    location: name,
    now: { temp: c.temperature_2m, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m, desc: codes[c.weather_code] || `code ${c.weather_code}` },
    next24h: (wx.hourly?.temperature_2m || []).slice(0, 24).map((t, i) => ({ hour: i, temp: t, desc: codes[wx.hourly.weather_code[i]] || "" })),
  });
}

function calculator({ expression }) {
  return String(safeEval(expression));
}

function safeEval(expr) {
  const tokens = tokenize(expr);
  let pos = 0;
  function peek() { return tokens[pos]; }
  function eat(t) { if (peek() !== t) throw new Error(`Expected ${t}`); pos++; }
  function parseExpr() {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") { const op = tokens[pos++]; v = op === "+" ? v + parseTerm() : v - parseTerm(); }
    return v;
  }
  function parseTerm() {
    let v = parsePow();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = tokens[pos++];
      const r = parsePow();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function parsePow() {
    let v = parseUnary();
    if (peek() === "^") { pos++; v = Math.pow(v, parsePow()); }
    return v;
  }
  function parseUnary() {
    if (peek() === "-") { pos++; return -parseAtom(); }
    return parseAtom();
  }
  function parseAtom() {
    const t = peek();
    if (t === "(") { pos++; const v = parseExpr(); eat(")"); return v; }
    if (!isNaN(Number(t))) { pos++; return Number(t); }
    const fns = { sqrt: Math.sqrt, abs: Math.abs, log: Math.log, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, pow: Math.pow, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil };
    const consts = { pi: Math.PI, e: Math.E };
    if (consts[t]) { pos++; return consts[t]; }
    if (fns[t]) { pos++; eat("("); const args = [parseExpr()]; while (peek() === ",") { pos++; args.push(parseExpr()); } eat(")"); return fns[t](...args); }
    throw new Error(`Unexpected: ${t}`);
  }
  const r = parseExpr();
  if (pos < tokens.length) throw new Error("Unexpected trailing input");
  return r;
}

function tokenize(s) {
  const r = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if ("+-*/%^(),".includes(s[i])) { r.push(s[i++]); continue; }
    if (/[0-9.]/.test(s[i])) { let n = ""; while (i < s.length && /[0-9.eE]/.test(s[i])) n += s[i++]; r.push(n); continue; }
    if (/[a-z]/i.test(s[i])) { let w = ""; while (i < s.length && /[a-z]/i.test(s[i])) w += s[i++]; r.push(w.toLowerCase()); continue; }
    i++;
  }
  return r;
}

function current_time({ timezone }) {
  const tz = timezone || "Asia/Jerusalem";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "full", timeStyle: "medium", timeZone: tz });
  return fmt.format(now);
}

const DEFS = [
  { name: "web_search", description: "Search the web via DuckDuckGo", input_schema: { type: "object", properties: { query: { type: "string" }, lang: { type: "string", default: "he-il" } }, required: ["query"] } },
  { name: "web_fetch", description: "Fetch a web page and extract text content", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "weather", description: "Get weather for a location", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } },
  { name: "calculator", description: "Evaluate a math expression safely", input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  { name: "current_time", description: "Get current date and time", input_schema: { type: "object", properties: { timezone: { type: "string", default: "Asia/Jerusalem" } }, required: [] } },
];

const RUNNERS = { web_search, web_fetch, weather, calculator, current_time };
const ACTION_TYPES = { web_search: "web_search", web_fetch: "web_search", weather: "weather", calculator: "calculator", current_time: "current_time" };

module.exports = { DEFS, RUNNERS, ACTION_TYPES };
