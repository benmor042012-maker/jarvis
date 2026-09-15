#!/usr/bin/env node
// One-command Cloudflare setup for the JARVIS Worker.
//
//   npm run setup
//
// It creates the D1 database and the Vectorize index, writes the real
// database_id into wrangler.toml, applies schema.sql, asks Cloudflare to store
// your Anthropic key as a secret, and deploys. Every step is skipped if it is
// already done, so running it twice is safe.
//
// The Anthropic key is typed straight into `wrangler secret put`, so it never
// passes through this script, never lands in a file, and never gets logged.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOML = join(ROOT, "wrangler.toml");
const SCHEMA = join(ROOT, "schema.sql");
const DB_NAME = "jarvis-memory";
const INDEX_NAME = "jarvis-memories";
const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_ID";

const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const ok = (m) => console.log(`${C.g}  ✔${C.r} ${m}`);
const warn = (m) => console.log(`${C.y}  !${C.r} ${m}`);
const bad = (m) => console.log(`${C.red}  ✕${C.r} ${m}`);
const step = (n, m) => console.log(`\n${C.b}${C.c}[${n}]${C.r} ${C.b}${m}${C.r}`);

function wrangler(args, { capture = true } = {}) {
  const res = spawnSync("npx", ["--yes", "wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  return {
    code: res.status ?? 1,
    out: (res.stdout || "") + (res.stderr || ""),
  };
}

// Runs wrangler attached to the real terminal, so it can prompt for input.
function wranglerInteractive(args) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["--yes", "wrangler", ...args], {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    p.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function ask(question, fallback = "") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer || fallback;
}

function readToml() {
  return readFileSync(TOML, "utf8");
}

function findDatabaseId() {
  const { code, out } = wrangler(["d1", "list", "--json"]);
  if (code !== 0) return { error: out };
  const start = out.indexOf("[");
  if (start === -1) return { id: null };
  try {
    const list = JSON.parse(out.slice(start, out.lastIndexOf("]") + 1));
    const hit = list.find((d) => d.name === DB_NAME);
    return { id: hit ? hit.uuid || hit.database_id || null : null };
  } catch {
    return { id: null };
  }
}

async function main() {
  console.log(`\n${C.b}JARVIS — Cloudflare setup${C.r}`);
  console.log(`${C.dim}Creates the database, the memory index and deploys the Worker.${C.r}`);

  if (!existsSync(TOML)) {
    bad("wrangler.toml not found. Run this from the project root.");
    process.exit(1);
  }

  // --- 1. Cloudflare account -------------------------------------------------
  step(1, "Cloudflare account");
  let who = wrangler(["whoami"]);
  if (who.code !== 0 || /not authenticated|log ?in/i.test(who.out)) {
    warn("Not logged in. A browser window will open for Cloudflare login.");
    const code = await wranglerInteractive(["login"]);
    if (code !== 0) {
      bad("Login failed. Run `npx wrangler login` yourself, then re-run `npm run setup`.");
      process.exit(1);
    }
    who = wrangler(["whoami"]);
  }
  const email = (who.out.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0];
  ok(`Logged in${email ? ` as ${email}` : ""}.`);

  // --- 2. D1 database --------------------------------------------------------
  step(2, "Database (D1) — memory, reminders, briefings");
  let toml = readToml();
  let dbId = null;
  let found = findDatabaseId();

  if (found.error) {
    warn("Could not list D1 databases. Continuing without memory.");
  } else {
    if (!found.id) {
      console.log(`${C.dim}  creating ${DB_NAME}...${C.r}`);
      const created = wrangler(["d1", "create", DB_NAME]);
      if (created.code !== 0 && !/already exists/i.test(created.out)) {
        warn(`Could not create the database: ${created.out.trim().split("\n").slice(-1)[0]}`);
      }
      found = findDatabaseId();
    }
    dbId = found.id;
  }

  if (dbId) {
    if (toml.includes(PLACEHOLDER)) {
      toml = toml.replace(PLACEHOLDER, dbId);
      writeFileSync(TOML, toml, "utf8");
      ok(`Database ready and wired into wrangler.toml (${dbId.slice(0, 8)}…).`);
    } else if (!toml.includes(dbId)) {
      toml = toml.replace(/database_id = "[^"]*"/, `database_id = "${dbId}"`);
      writeFileSync(TOML, toml, "utf8");
      ok(`Database id updated (${dbId.slice(0, 8)}…).`);
    } else {
      ok("Database already wired up.");
    }
  } else {
    // A deploy with the placeholder id always fails. Better to ship a working
    // chat-only Worker than to leave the user with nothing.
    warn("No D1 database available. JARVIS will run without memory, reminders or the morning briefing.");
    warn("Chat, search, weather and the desktop app still work. Re-run `npm run setup` later to add memory.");
    toml = toml.replace(/^(\[\[d1_databases\]\][\s\S]*?database_id = "[^"]*")/m, (m) =>
      m.split("\n").map((l) => (l.startsWith("#") ? l : `# ${l}`)).join("\n"),
    );
    toml = toml.replace(/^(\[\[vectorize\]\][\s\S]*?index_name = "[^"]*")/m, (m) =>
      m.split("\n").map((l) => (l.startsWith("#") ? l : `# ${l}`)).join("\n"),
    );
    writeFileSync(TOML, toml, "utf8");
  }

  // --- 3. Vectorize index ----------------------------------------------------
  if (dbId) {
    step(3, "Memory index (Vectorize) — semantic recall");
    const list = wrangler(["vectorize", "list"]);
    if (list.out.includes(INDEX_NAME)) {
      ok("Index already exists.");
    } else {
      const created = wrangler(["vectorize", "create", INDEX_NAME, "--dimensions=1024", "--metric=cosine"]);
      if (created.code === 0 || /already exists/i.test(created.out)) {
        ok("Index created.");
      } else {
        warn("Could not create the Vectorize index. Memory still works, just without semantic search.");
      }
    }

    // --- 4. Tables -----------------------------------------------------------
    step(4, "Tables");
    const applied = wrangler(["d1", "execute", DB_NAME, "--remote", `--file=${SCHEMA}`, "-y"]);
    if (applied.code === 0) ok("Tables created (memories, reminders, google_tokens, briefings, telegram_history).");
    else warn(`Could not apply schema.sql automatically. Run it yourself:\n     npx wrangler d1 execute ${DB_NAME} --remote --file=schema.sql`);
  }

  // --- 5. Anthropic key ------------------------------------------------------
  step(5, "Claude API key — the brain");
  const secrets = wrangler(["secret", "list"]);
  if (secrets.out.includes("ANTHROPIC_API_KEY")) {
    ok("Key already stored.");
    const replace = await ask(`${C.dim}  Replace it? [y/N] ${C.r}`, "n");
    if (/^y/i.test(replace)) await wranglerInteractive(["secret", "put", "ANTHROPIC_API_KEY"]);
  } else {
    console.log(`${C.dim}  Get one at https://console.anthropic.com — it starts with sk-ant-${C.r}`);
    console.log(`${C.dim}  Paste it at the prompt. It goes straight to Cloudflare, not through this script.${C.r}\n`);
    const code = await wranglerInteractive(["secret", "put", "ANTHROPIC_API_KEY"]);
    if (code === 0) ok("Key stored as a Cloudflare secret.");
    else warn("Key not stored. JARVIS cannot answer until you run: npx wrangler secret put ANTHROPIC_API_KEY");
  }

  // --- 6. Deploy -------------------------------------------------------------
  step(6, "Deploy");
  const deployed = wrangler(["deploy"]);
  const url = (deployed.out.match(/https:\/\/[\w.-]+\.workers\.dev/) || [])[0];
  if (deployed.code !== 0) {
    bad("Deploy failed:");
    console.log(deployed.out.trim().split("\n").slice(-12).join("\n"));
    process.exit(1);
  }
  ok(`Deployed${url ? `: ${url}` : "."}`);

  console.log(`\n${C.b}${C.g}Done.${C.r}`);
  if (url) {
    console.log(`\n  Check what is live:   ${C.c}${url}/setup${C.r}`);
    console.log(`  Talk to JARVIS:       ${C.c}https://benmor042012-maker.github.io/jarvis/${C.r}`);
    console.log(`\n${C.dim}  If the web page points at a different Worker, update PROXY_URL in index.html.${C.r}`);
  }
  console.log(`\n${C.dim}  Optional next steps: Gmail + Calendar → SETUP-GOOGLE.md · Telegram → ${url || "<worker>"}/telegram/setup${C.r}\n`);
}

main().catch((e) => {
  bad(String(e?.message || e));
  process.exit(1);
});
