// Messages to people, without a messaging provider.
//
// WhatsApp has no free, official way for a program on your computer to send a
// message on your behalf: the Business API is paid and needs an account, and
// driving WhatsApp Web from the outside is against its terms and breaks
// without warning. What WhatsApp does provide, free and officially, is a link
// that opens a chat with the message already typed — https://wa.me/<number>?text=
// — which WhatsApp Desktop or WhatsApp Web picks up.
//
// So this does exactly that: opens the right chat with your words in the box.
// You press Send. JARVIS never claims to have sent anything, because it has
// not, and nothing here leaves the computer except through WhatsApp itself when
// you decide.
const paths = require("../paths");
const { openWithDefault } = require("./apps");

/**
 * A phone number as WhatsApp wants it: digits only, country code first, no
 * plus. An Israeli number written the local way (05x-xxx-xxxx) becomes 9725x…
 */
function normalizeNumber(raw, defaultCountry = "972") {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = defaultCountry + d.slice(1);
  if (!/^\d{8,15}$/.test(d)) return null;
  return d;
}

/** A name from the contacts list, or a number written in the command. */
function resolveRecipient(to, cfg) {
  const contacts = Array.isArray(cfg?.contacts) ? cfg.contacts : [];
  const wanted = String(to || "").trim().toLowerCase();
  const byName = contacts.find((c) => String(c.name || "").trim().toLowerCase() === wanted);
  if (byName) {
    const number = normalizeNumber(byName.phone);
    if (!number) throw new Error(`The number saved for "${byName.name}" (${String(byName.phone)}) is not a valid phone number.`);
    return { name: byName.name, number };
  }
  const number = normalizeNumber(to);
  if (number) return { name: null, number };
  const known = contacts.map((c) => c.name).filter(Boolean);
  throw new Error(
    `I don't have a number for "${String(to)}". ${known.length ? `Contacts I know: ${known.join(", ")}.` : "No contacts are saved yet."} Add one in Settings → Contacts (a name and a phone number, kept only on this computer).`,
  );
}

const open_chat_draft = {
  name: "open_chat_draft", title: "Open a WhatsApp chat with the message typed (you press Send)", category: "messaging", risk: "medium", reversible: true, timeoutMs: 10000,
  description: "Open a WhatsApp chat with a contact or a phone number, with the message already typed. The message is NOT sent: WhatsApp opens with it in the box and the user presses Send.",
  schema: {
    type: "object",
    properties: {
      to: { type: "string", minLength: 1, maxLength: 80, description: "A contact name from Settings → Contacts, or a phone number" },
      text: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["to", "text"],
  },
  describe: (p) => `Open WhatsApp to ${String(p.to)} with the message typed (not sent)`,
  // The message and the recipient are private: kept out of the log.
  redact: (p) => ({ to: p.to ? "[contact]" : undefined, chars: String(p.text || "").length }),
  async run({ to, text }, { cfg }) {
    const who = resolveRecipient(to, cfg);
    const url = `https://wa.me/${who.number}?text=${encodeURIComponent(String(text).trim())}`;
    openWithDefault(url);
    return {
      ok: true,
      summary: `WhatsApp is open to ${who.name || who.number} with your message typed. Nothing was sent — press Send there when you are ready.`,
      data: { to: who.name || who.number, sent: false, chars: String(text).trim().length },
    };
  },
};

const contacts_list = {
  name: "contacts_list", title: "Contacts", category: "messaging", risk: "low", reversible: true, timeoutMs: 2000,
  description: "The names in Settings → Contacts (numbers are not read aloud).",
  schema: { type: "object", properties: {} },
  describe: () => "List contacts",
  async run(_p, { cfg }) {
    const names = (Array.isArray(cfg?.contacts) ? cfg.contacts : []).map((c) => String(c.name || "")).filter(Boolean);
    return { ok: true, summary: names.length ? `Contacts: ${names.join(", ")}.` : "No contacts saved. Add them in Settings → Contacts.", data: { names, file: paths.HOME } };
  },
};

module.exports = { tools: [open_chat_draft, contacts_list], normalizeNumber, resolveRecipient };
