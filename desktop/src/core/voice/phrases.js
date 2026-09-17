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
function stripPhrase(text, phrase, { near = 0 } = {}) {
  const t = words(text);
  const p = words(phrase);
  for (let i = 0; i + p.length <= t.length; i++) {
    let hit = true;
    for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) { hit = false; break; }
    if (hit) return [...t.slice(0, i), ...t.slice(i + p.length)].join(" ").trim();
  }
  // The wake phrase can be recognised as a near miss, and then it is not in the
  // text to remove letter for letter. Without this the misheard spelling of the
  // wake word became the command: say "תתעור" and JARVIS goes looking for a
  // file called that.
  if (near > 0) {
    const joined = p.join(" ");
    let best = null;
    for (const span of [p.length, p.length + 1, Math.max(1, p.length - 1)]) {
      for (let i = 0; i + span <= t.length; i++) {
        const d = distance(t.slice(i, i + span).join(" "), joined);
        if (d <= near && (best === null || d < best.d)) best = { i, span, d };
      }
    }
    if (best) return [...t.slice(0, best.i), ...t.slice(best.i + best.span)].join(" ").trim();
  }
  return normalize(text);
}

/**
 * Edit distance between two words, capped — we only ever care about "one or two
 * letters out", so the whole table is never needed.
 */
function distance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

// How wrong a wake phrase may come back and still count. A local speech model
// transcribing one short Hebrew word gets a letter wrong often — "תתעורר" comes
// back as "תתעור" — and refusing that is indistinguishable, to the person
// speaking, from not listening at all. One letter in four, never more, and
// never for a phrase short enough that a different word could fall inside it.
const NEAR_RATIO = 0.25;
// Five characters, so a four-letter Hebrew word - which has a dozen close 
// neighbours - only ever matches exactly.
const MIN_FUZZY_LEN = 5;

/** How far `text` is from containing `phrase`, in letters: 0 is exact, null is nowhere near. */
function nearness(text, phrase) {
  const t = words(text);
  const p = words(phrase);
  if (!p.length || !t.length) return null;
  const joined = p.join(" ");
  const budget = joined.length < MIN_FUZZY_LEN ? 0 : Math.max(1, Math.floor(joined.length * NEAR_RATIO));
  let best = null;
  // Windows of the same length as the phrase, and one word either side, so a
  // word split in two ("תת עורר") is still found.
  for (const span of [p.length, p.length + 1, Math.max(1, p.length - 1)]) {
    for (let i = 0; i + span <= t.length; i++) {
      const d = distance(t.slice(i, i + span).join(" "), joined);
      if (best === null || d < best) best = d;
    }
  }
  return best !== null && best <= budget ? best : null;
}

/**
 * The first phrase from `list` that `text` contains or very nearly contains,
 * with how far off it was. Exact matches always win over near ones.
 */
function matchClose(text, list) {
  const exact = matchAny(text, list);
  if (exact) return { phrase: exact, distance: 0 };
  let hit = null;
  for (const phrase of list || []) {
    const d = nearness(text, phrase);
    if (d !== null && (hit === null || d < hit.distance)) hit = { phrase, distance: d };
  }
  return hit;
}

module.exports = { normalize, words, containsPhrase, matchAny, matchClose, nearness, distance, stripPhrase };
