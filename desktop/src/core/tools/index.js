const { ToolRegistry } = require("../registry");

function buildRegistry() {
  const reg = new ToolRegistry();
  for (const mod of [require("./apps"), require("./files"), require("./screen"), require("./input"), require("./clipboard"), require("./shell"), require("./info"), require("./drafts_tools"), require("./browser")]) {
    for (const t of mod.tools) reg.register(t);
  }
  return reg;
}

module.exports = { buildRegistry };
