#!/usr/bin/env node
// Runs the JARVIS agent without Electron (Linux/macOS/CI or a Windows service
// account). No tray, no hotkey, no browser automation, no native
// confirmation dialog: high-risk actions approved from a phone are refused
// with a clear reason, because there is nobody at the computer to confirm.
const path = require("path");
const { Agent } = require("./src/core/agent");

async function main() {
  // No window, so no Web Audio and no speech synthesis: an alert prints here
  // and reaches every connected JARVIS page, which is what plays the sound and
  // speaks. The alert record says which channels actually fired.
  const agent = new Agent({ host: { notify: (title, body) => console.log(`[notify] ${title}: ${body}`) } });
  const info = await agent.start({ staticRoot: path.join(__dirname, "..", "client", "dist") });
  const owner = agent.ownerDevice();
  const code = agent.devices.createPairCode();
  console.log(`JARVIS agent (headless) listening on http://${info.host}:${info.port}/`);
  console.log(`Owner device id: ${owner.id}`);
  console.log(`Pairing code (5 minutes): ${code.code}`);
  console.log("High-risk actions cannot be confirmed in headless mode. Start the desktop app for full features.");
  console.log("Voice: open this address in Chrome or Edge on this computer — the microphone is opened by the page, not by this process.");
  const stop = () => { agent.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error("failed to start:", e.message); process.exit(1); });
