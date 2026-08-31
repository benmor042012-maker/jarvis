// tools/index.js
// Registry of all tools. Every tool = { def, run(env, userId, args) }.
// A new tool = one file + one entry here. That's it.

import { web_search, web_search_def } from "./web_search.js";
import { web_fetch, web_fetch_def } from "./web_fetch.js";
import { weather, weather_def } from "./weather.js";
import { calculator, calculator_def } from "./calculator.js";
import { current_time, time_def } from "./time_tool.js";
import {
  reminder_set, reminder_set_def,
  reminder_list, reminder_list_def,
  reminder_cancel, reminder_cancel_def,
} from "./reminders.js";
import {
  memory_write, memory_write_def,
  memory_search, memory_search_def,
  memory_forget, memory_forget_def,
} from "./memory_tools.js";

// Each tool declares whether it uses paid services. Cost Guard reads this.
export const TOOLS = {
  web_search:      { def: web_search_def,      run: async (env, uid, a) => web_search(a),      paid: false, source: "DuckDuckGo HTML (free)" },
  web_fetch:       { def: web_fetch_def,       run: async (env, uid, a) => web_fetch(a),        paid: false, source: "Cloudflare Worker fetch (free)" },
  weather:         { def: weather_def,         run: async (env, uid, a) => weather(a),          paid: false, source: "Open-Meteo (free)" },
  calculator:      { def: calculator_def,      run: async (env, uid, a) => calculator(a),       paid: false, source: "Local (free)" },
  current_time:    { def: time_def,            run: async (env, uid, a) => current_time(a),     paid: false, source: "Local (free)" },
  reminder_set:    { def: reminder_set_def,    run: (env, uid, a) => reminder_set(env, uid, a), paid: false, source: "Cloudflare D1 (free tier)" },
  reminder_list:   { def: reminder_list_def,   run: (env, uid, a) => reminder_list(env, uid),   paid: false, source: "Cloudflare D1 (free tier)" },
  reminder_cancel: { def: reminder_cancel_def, run: (env, uid, a) => reminder_cancel(env, uid, a), paid: false, source: "Cloudflare D1 (free tier)" },
  memory_write:    { def: memory_write_def,    run: (env, uid, a) => memory_write(env, uid, a), paid: false, source: "Cloudflare D1 + Vectorize + Workers AI (free tier)" },
  memory_search:   { def: memory_search_def,   run: (env, uid, a) => memory_search(env, uid, a), paid: false, source: "Cloudflare D1 + Vectorize (free tier)" },
  memory_forget:   { def: memory_forget_def,   run: (env, uid, a) => memory_forget(env, uid, a), paid: false, source: "Cloudflare D1 (free tier)" },
};

export function toolDefinitions() {
  return Object.values(TOOLS).map((t) => t.def);
}

// Runs a single tool call. Returns a plain object (Claude serializes to JSON).
export async function runTool(env, userId, name, args) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool: ${name}` };
  // Cost Guard: refuse paid tools unless explicitly enabled per-env
  if (tool.paid && env.PAID_TOOLS_ENABLED !== "true") {
    return {
      error: `⚠️ הכלי ${name} דורש שירות בתשלום ולא הופעל. לא רץ.`,
      paid_blocked: true,
      source: tool.source,
    };
  }
  try {
    return await tool.run(env, userId, args || {});
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
