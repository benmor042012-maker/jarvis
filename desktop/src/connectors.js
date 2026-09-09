// Connectors = remote MCP servers reached through the Messages API's MCP
// connector (beta mcp-client-2025-11-20).
//
// IMPORTANT SAFETY NOTE: these tools run on Anthropic's servers, not here.
// Claude calls them and the results come back in the same response, so the
// local permission system (ASK / CONFIRM / HIGH_RISK) never sees them and
// cannot put an approval dialog in front of them. The only real control is
// which tools are enabled, which is why a new connector enables nothing until
// its tools have been discovered and chosen.

const fs = require("fs");
const path = require("path");
const { JARVIS_HOME } = require("./config");

const CONNECTORS_PATH = path.join(JARVIS_HOME, "connectors.json");

// Used only to pre-tick sensible boxes after discovery. A name is a hint, not
// a guarantee — the user confirms every tool before it is enabled.
const READ_ONLY_HINT = /^(get|list|search|read|fetch|find|query|view|show|describe|count|check)[_-]?/i;

function loadAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONNECTORS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  fs.mkdirSync(path.dirname(CONNECTORS_PATH), { recursive: true });
  fs.writeFileSync(CONNECTORS_PATH, JSON.stringify(list, null, 2), "utf8");
}

// The API requires a unique name per server, referenced by exactly one toolset.
function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function validate(c) {
  const name = normalizeName(c.name);
  if (!name) throw new Error("שם החיבור חסר.");
  if (!/^https:\/\//i.test(c.url || "")) throw new Error("כתובת החיבור חייבת להתחיל ב-https://");
  return name;
}

function save(connector) {
  const name = validate(connector);
  const list = loadAll();
  const idx = list.findIndex((c) => c.name === name);
  const existing = idx === -1 ? {} : list[idx];
  const merged = {
    ...existing,
    name,
    url: connector.url,
    token: connector.token !== undefined ? connector.token : existing.token || "",
    enabled: connector.enabled !== undefined ? !!connector.enabled : existing.enabled !== false,
    // { toolName: { enabled: bool } } — nothing runs until something is ticked.
    tools: connector.tools !== undefined ? connector.tools : existing.tools || {},
  };
  if (idx === -1) list.push(merged);
  else list[idx] = merged;
  saveAll(list);
  return merged;
}

function remove(name) {
  const n = normalizeName(name);
  saveAll(loadAll().filter((c) => c.name !== n));
  return true;
}

function enabledTools(c) {
  return Object.entries(c.tools || {})
    .filter(([, t]) => t && t.enabled)
    .map(([n]) => n);
}

function active() {
  return loadAll().filter((c) => c.enabled !== false && c.url && enabledTools(c).length > 0);
}

// Builds the two halves the API requires. A server in mcp_servers with no
// matching mcp_toolset is a validation error, so these are always built together.
function buildRequestParts(connectors) {
  const servers = [];
  const toolsets = [];
  for (const c of connectors) {
    servers.push({
      type: "url",
      url: c.url,
      name: c.name,
      ...(c.token ? { authorization_token: c.token } : {}),
    });
    const configs = {};
    for (const [toolName, t] of Object.entries(c.tools || {})) {
      configs[toolName] = { enabled: !!(t && t.enabled) };
    }
    toolsets.push({
      type: "mcp_toolset",
      mcp_server_name: c.name,
      // Deny by default: a tool the user never ticked stays off, including
      // tools the server adds later.
      default_config: { enabled: false },
      configs,
    });
  }
  return { servers, toolsets };
}

// One server, every tool enabled — used only to ask Claude what the server
// offers. The result is presented for the user to choose from; nothing is
// enabled as a side effect of discovery.
function discoveryParts(connector) {
  return {
    servers: [
      {
        type: "url",
        url: connector.url,
        name: connector.name,
        ...(connector.token ? { authorization_token: connector.token } : {}),
      },
    ],
    toolsets: [
      {
        type: "mcp_toolset",
        mcp_server_name: connector.name,
        default_config: { enabled: true },
      },
    ],
  };
}

function looksReadOnly(toolName) {
  return READ_ONLY_HINT.test(String(toolName || ""));
}

module.exports = {
  loadAll, saveAll, save, remove, active, enabledTools,
  buildRequestParts, discoveryParts, looksReadOnly, normalizeName,
  CONNECTORS_PATH,
};
