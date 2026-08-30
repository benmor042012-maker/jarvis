const web = require("./web");
const memory = require("./memory-remote");
const reminders = require("./reminders-remote");
const computer = require("./computer");

const modules = [web, memory, reminders, computer];

function definitions() {
  const all = [];
  for (const m of modules) {
    for (const d of m.DEFS) all.push(d);
  }
  return all;
}

function findModule(toolName) {
  for (const m of modules) {
    if (m.RUNNERS[toolName]) return m;
  }
  return null;
}

async function run(toolName, input) {
  const m = findModule(toolName);
  if (!m) throw new Error(`Unknown tool: ${toolName}`);
  return m.RUNNERS[toolName](input);
}

function actionType(toolName) {
  for (const m of modules) {
    if (m.ACTION_TYPES && m.ACTION_TYPES[toolName]) return m.ACTION_TYPES[toolName];
  }
  return toolName;
}

function isUndoable(toolName) {
  for (const m of modules) {
    if (m.UNDOABLE && m.UNDOABLE.has(toolName)) return true;
  }
  return false;
}

module.exports = { definitions, run, actionType, isUndoable };
