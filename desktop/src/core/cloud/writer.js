// The writing agent: emails, messages, posts, documents and code, written to
// order and shown to you. It produces text and nothing else — no tools, no
// plan, no send. What happens to the text afterwards is your click: copy it,
// open it in WhatsApp, or send it to one of your connections.
const groq = require("./groq");
const local = require("../planner/local-model");

const KINDS = {
  email: "an email. Start with a subject line as 'Subject: …', then the body",
  message: "a short chat message (WhatsApp/SMS style), friendly and to the point",
  post: "a social media post",
  doc: "a document section with a title and clear paragraphs",
  code: "code. Output only the code in one fenced block, with brief comments",
  other: "the requested text",
};

async function write(cfg, { kind = "other", instructions = "", tone = "", language = "" } = {}, { signal } = {}) {
  const what = KINDS[kind] ? kind : "other";
  const ask = String(instructions || "").trim().slice(0, 4000);
  if (!ask) throw Object.assign(new Error("Say what to write."), { status: 400 });
  const lang = String(language || cfg.language || "he") === "he" ? "Hebrew" : "the language of the request";
  const system = `You are a writing assistant. Write ${KINDS[what]}.
Write in ${lang}${tone ? `, in a ${String(tone).slice(0, 40)} tone` : ""}.
Output only the text itself — no preface, no notes, no options. Never claim anything was sent.
Do not invent facts about real people, prices or dates; leave [brackets] where a detail is needed.`;
  if (!groq.unusable(cfg)) {
    const text = await groq.chat(cfg, { system, user: ask, maxTokens: what === "code" ? 1500 : 900, temperature: 0.5, timeoutMs: 45000, signal });
    return { text: text.trim(), provider: "groq", model: groq.modelFor(cfg) };
  }
  const resolved = await local.resolve(cfg);
  if (resolved.provider === "mock") {
    throw Object.assign(new Error(`The writing agent needs a brain: add a free Groq key in Connections (${groq.unusable(cfg)}), or install a local model.`), { status: 409 });
  }
  const text = await local.generate(cfg, resolved, system, ask, { signal });
  return { text: String(text).trim(), provider: resolved.provider, model: resolved.model };
}

module.exports = { write, KINDS };
