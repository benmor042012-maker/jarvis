// Browser automation through the JARVIS window's own Chromium (Electron).
// The host provides ctx.host.browser = { fill(url, fields, {submit, signal}) }.
// Step 1 (medium): open the page and fill the fields, returning a preview.
// Step 2 (high):   submit — only ever after the user approved the preview.
const { validateUrl } = require("./apps");

const FIELD = { type: "object", properties: { selector: { type: "string", minLength: 1, maxLength: 300 }, value: { type: "string", maxLength: 5000 } }, required: ["selector", "value"] };

function needHost(ctx) {
  if (!ctx.host || !ctx.host.browser) return { ok: false, reason: "Browser automation needs the JARVIS desktop window (it uses the built-in Chromium). Not available in headless mode." };
  return { ok: true };
}

const browser_fill_form = {
  name: "browser_fill_form", title: "Fill web form (preview)", category: "browser", risk: "medium", reversible: true, timeoutMs: 90000,
  description: "Open a page in the JARVIS browser window and fill form fields WITHOUT submitting. Returns a preview of what was filled.",
  schema: { type: "object", properties: { url: { type: "string", minLength: 1, maxLength: 2048 }, fields: { type: "array", items: FIELD, minItems: 1, maxItems: 40 } }, required: ["url", "fields"] },
  describe: (p) => `Fill ${p.fields.length} field(s) on ${p.url} (no submit)`,
  redact: (p) => ({ url: p.url, fields: p.fields.map((f) => ({ selector: f.selector, chars: f.value.length })) }),
  available: needHost,
  async run({ url, fields }, ctx) {
    const clean = validateUrl(url, ctx.cfg);
    const result = await ctx.host.browser.fill(clean, fields, { submit: false, signal: ctx.signal });
    return { ok: true, summary: `Filled ${result.filled}/${fields.length} field(s) on ${clean}. Nothing submitted.`, data: { url: clean, preview: result.preview, missing: result.missing } };
  },
};

const browser_submit_form = {
  name: "browser_submit_form", title: "Submit web form", category: "browser", risk: "high", reversible: false, timeoutMs: 90000,
  description: "Fill and SUBMIT a form in the JARVIS browser window. Requires approval of the exact URL, fields and submit button.",
  schema: { type: "object", properties: { url: { type: "string", minLength: 1, maxLength: 2048 }, fields: { type: "array", items: FIELD, maxItems: 40, default: [] }, submit_selector: { type: "string", minLength: 1, maxLength: 300 } }, required: ["url", "submit_selector"] },
  describe: (p) => `SUBMIT form on ${p.url} via ${p.submit_selector}`,
  redact: (p) => ({ url: p.url, submit_selector: p.submit_selector, fields: (p.fields || []).map((f) => ({ selector: f.selector, chars: f.value.length })) }),
  available: needHost,
  async run({ url, fields, submit_selector }, ctx) {
    const clean = validateUrl(url, ctx.cfg);
    const result = await ctx.host.browser.fill(clean, fields, { submit: submit_selector, signal: ctx.signal });
    return { ok: result.submitted, summary: result.submitted ? `Submitted form on ${clean}` : `Could not submit: ${result.error || "button not found"}`, data: { url: clean, final_url: result.finalUrl } };
  },
};

module.exports = { tools: [browser_fill_form, browser_submit_form] };
