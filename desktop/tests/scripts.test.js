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
  const { windowsCommandLine } = await import(path.join(SCRIPTS, "spawn-compat.mjs"));
  assert.equal(windowsCommandLine("npm", ["--prefix", "client", "install"]), "npm --prefix client install");
  assert.equal(windowsCommandLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "build"]), '"C:\\Program Files\\nodejs\\npm.cmd" run build');
  for (const bad of ["a & calc.exe", "a | b", "a > out", "%PATH%", 'say "hi"', "a\nb", "a^b"]) {
    assert.throws(() => windowsCommandLine("npm", [bad]), /unsafe argument/, `should refuse: ${bad}`);
  }
});
