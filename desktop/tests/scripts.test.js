// The launcher scripts run npm and electron. On Windows those are .cmd files,
// which Node will only spawn through a shell — and pairing a shell with an
// args array makes Node concatenate the arguments unescaped (DEP0190). These
// tests pin the safe form: one quoted command line, no args array.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SCRIPTS = path.join(__dirname, "..", "..", "scripts");

test("no launcher pairs an args array with shell:true", () => {
  for (const file of fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    const text = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
    for (const m of text.matchAll(/spawn(?:Sync)?\(([^;]*?)\)\s*[;,)]/gs)) {
      const call = m[1];
      if (/shell\s*:/.test(call)) {
        assert.ok(!/\[[^\]]*\]\s*,/.test(call), `${file}: spawn with shell must not pass an args array:\n${call}`);
      }
    }
  }
});

test("windows command lines quote arguments and refuse dangerous ones", async () => {
  // On Windows an absolute path is not a valid ESM specifier ("protocol 'd:'"),
  // so the dynamic import needs a file:// URL.
  const { windowsCommandLine } = await import(require("url").pathToFileURL(path.join(SCRIPTS, "spawn-compat.mjs")).href);
  assert.equal(windowsCommandLine("npm", ["--prefix", "client", "install"]), "npm --prefix client install");
  assert.equal(windowsCommandLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "build"]), '"C:\\Program Files\\nodejs\\npm.cmd" run build');
  for (const bad of ["a & calc.exe", "a | b", "a > out", "%PATH%", 'say "hi"', "a\nb", "a^b"]) {
    assert.throws(() => windowsCommandLine("npm", [bad]), /unsafe argument/, `should refuse: ${bad}`);
  }
});

test("the local-AI installer explains itself instead of crashing when Ollama is absent", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "install-ai.mjs")], {
    encoding: "utf8",
    timeout: 60000,
    input: "",
    env: { ...process.env, PATH: "/nonexistent", JARVIS_OLLAMA_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ollama\.com\/download/);
  assert.match(r.stdout, /free, open source/);
  assert.ok(!/api[_-]?key|account|credit card|subscription/i.test(r.stdout), "must not ask for an account or a key");
});

test("npm run ai is wired and the model table is coherent", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.ai, "node scripts/install-ai.mjs");
  const text = fs.readFileSync(path.join(SCRIPTS, "install-ai.mjs"), "utf8");
  const ids = [...text.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, "should offer a few models");
  for (const id of ids) assert.match(id, /^[a-z0-9.]+:[a-z0-9.]+$/, `${id} should be an ollama model tag`);
  // The smallest option must be last so low-RAM machines still get a choice.
  const needs = [...text.matchAll(/needsGb: (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(needs, [...needs].sort((a, b) => b - a), "models should be listed from most to least demanding");
});
