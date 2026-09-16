// Literal phrase matching for wake and stop words.
//
// Nothing here uses a model: it is string comparison on a transcript, so the
// stop phrases keep working when no local model is installed, when JARVIS is in
// MOCK MODE, and while a task is already running.

// Strip niqqud/cantillation, normalise the several Unicode apostrophes Hebrew
// keyboards produce, drop punctuation, and collapse whitespace.
const NIQQUD = /[֑-ׇ]/g;
const APOSTROPHES = /[‘’׳'`´]/g;
const QUOTES = /[“”״"]/g;
const PUNCT = /[.,!?;:…"\-–—()[\]{}]/g;

function normalize(text) {
  return String(text || "")
    .replace(NIQQUD, "")
    .replace(APOSTROPHES, "")
    .replace(QUOTES, "")
    .replace(PUNCT, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function words(text) {
  const n = normalize(text);
  return n ? n.split(" ") : [];
}

/** True when `phrase` appears in `text` as whole words (Hebrew-safe). */
function containsPhrase(text, phrase) {
  const t = words(text);
  const p = words(phrase);
  if (!p.length || t.length < p.length) return false;
  for (let i = 0; i + p.length <= t.length; i++) {
    let hit = true;
    for (let j = 0; j < p.length; j++) {
      if (t[i + j] !== p[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/** The first phrase from `list` that appears in `text`, or null. */
function matchAny(text, list) {
  for (const phrase of list || []) {
    if (containsPhrase(text, phrase)) return phrase;
  }
  return null;
}

/**
 * Remove the wake phrase from the front of an utterance so
 * "תתעורר פתח פנקס רשימות" becomes "פתח פנקס רשימות".
 */
function stripPhrase(text, phrase) {
  const t = words(text);
  const p = words(phrase);
  for (let i = 0; i + p.length <= t.length; i++) {
    let hit = true;
    for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) { hit = false; break; }
    if (hit) return [...t.slice(0, i), ...t.slice(i + p.length)].join(" ").trim();
  }
  return normalize(text);
}

module.exports = { normalize, words, containsPhrase, matchAny, stripPhrase };
