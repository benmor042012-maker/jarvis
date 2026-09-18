#!/usr/bin/env node
// Runs everything a reviewer would run: tests, lint, typecheck, build, and a
// scan proving the product contains no cloud provider, API key or payment path.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { runSync } from "./spawn-compat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", red: "\x1b[31m", c: "\x1b[36m" };
let failed = 0;

function step(name, cmd, args, opts = {}) {
  process.stdout.write(`${C.c}▸${C.r} ${name}… `);
  const r = runSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  const ok = r.status === 0;
  console.log(ok ? `${C.g}pass${C.r}` : `${C.red}FAIL${C.r}`);
  if (!ok) {
    failed++;
    console.log((r.stdout || "") + (r.stderr || ""));
  }
  return r;
}

// Forbidden in the shipped product: cloud AI endpoints, key/token config,
// payment flows, telemetry. Tested here so a regression cannot slip in.
const FORBIDDEN = [
  [/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.telegram\.org|api\.cohere|api\.mistral/i, "cloud AI/provider endpoint"],
  [/ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_CLIENT_SECRET|TELEGRAM_BOT_TOKEN/i, "provider credential"],
  [/stripe|paddle\.com|checkout\.session|billing_portal/i, "payment flow"],
  [/google-analytics|googletagmanager|segment\.io|mixpanel|sentry\.io/i, "telemetry"],
];

// The optional phone relay is the one deliberate outbound path, and it is a
// blind pipe: it carries sealed frames only, and the agent will not dial it
// until the owner turns it on. So it is allowed inside its own boundary and
// nowhere else — a relay reference leaking into the tool layer, the permission
// engine or the agent loop would mean the pipe had grown opinions.
const RELAY_ALLOWED = [
  /^relay[\\/]/,
  /^desktop[\\/]src[\\/]core[\\/](relay-client|channel|config|agent|server)\.js$/,
  /^client[\\/]src[\\/](lib[\\/](channel|protocol)\.ts|api\.ts|types\.ts|state[\\/]jarvisStore\.ts|panels[\\/]DevicesPanel\.tsx)$/,
  /^README\.md$/,
];
const RELAY_RE = /workers\.dev|wrangler|cloudflare/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "assets", "docs", ".venv"]);

// Only tracked files are scanned: what is committed is what ships, and local
// scratch state (a test run's settings file, a venv) is not part of the product.
function tracked() {
  const r = runSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error("cannot list tracked files: " + (r.stderr || ""));
  return r.stdout
    .split("\0")
    .filter((rel) => rel && /\.(js|mjs|cjs|ts|tsx|html|json|md|bat|sh|yml|toml)$/.test(rel))
    .filter((rel) => !rel.split(/[\\/]/).some((part) => SKIP_DIRS.has(part)))
    .map((rel) => join(ROOT, rel))
    .filter((full) => existsSync(full) && statSync(full).size < 2_000_000);
}

process.stdout.write(`${C.c}▸${C.r} self-contained scan… `);
const hits = [];
for (const file of tracked()) {
  const rel = relative(ROOT, file);
  // The patterns live in this script, and the test suite asserts that such
  // endpoints are *refused* — neither ships inside the product.
  if (rel === join("scripts", "verify.mjs") || rel.split(/[\\/]/).includes("tests")) continue;
  const text = readFileSync(file, "utf8");
  for (const [re, label] of FORBIDDEN) {
    const m = re.exec(text);
    if (m) hits.push(`${rel}: ${label} (${m[0]})`);
  }
  const relay = RELAY_RE.exec(text);
  if (relay && !RELAY_ALLOWED.some((re) => re.test(rel))) {
    hits.push(`${rel}: relay reference outside the relay boundary (${relay[0]})`);
  }
}
if (hits.length) {
  failed++;
  console.log(`${C.red}FAIL${C.r}\n` + hits.map((h) => "  " + h).join("\n"));
} else console.log(`${C.g}pass${C.r} ${C.dim}(no cloud endpoint, credential, payment or telemetry reference; relay stays inside its boundary)${C.r}`);

step("agent tests", "npm", ["--prefix", "desktop", "test"]);
step("client typecheck", "npm", ["--prefix", "client", "run", "typecheck"]);
step("client lint (zero warnings)", "npx", ["--prefix", "client", "eslint", ".", "--max-warnings", "0"], { cwd: join(ROOT, "client") });
step("client build", "npm", ["--prefix", "client", "run", "build"]);

console.log(failed ? `\n${C.red}${String(failed)} check(s) failed.${C.r}\n` : `\n${C.g}${C.b}All checks passed.${C.r}\n`);
process.exit(failed ? 1 : 0);
