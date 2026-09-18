// Which speech model this computer should use — the decision, on its own.
//
// Separated from the script that runs it so it can be tested without spawning
// a speech engine: on Windows a stand-in engine cannot be spawned at all (there
// is no shebang, and Node refuses to run a .cmd without a shell), and a
// decision this consequential — it changes how well JARVIS understands Hebrew —
// should be covered on the platform most people run it on.
//
// It measures, walks down to smaller models only as far as it has to, and
// reports what it did. It never downloads a model it does not need, and it
// never claims a speed it has not measured.

/**
 * Multilingual models, heaviest first. The ".en" builds are not here at all:
 * they cannot transcribe Hebrew at any size.
 */
export const LADDER = [
  { file: "ggml-large-v3-turbo.bin", mb: 1624, hebrew: "the best Hebrew there is" },
  { file: "ggml-medium.bin", mb: 1533, hebrew: "very good Hebrew" },
  { file: "ggml-small.bin", mb: 466, hebrew: "good Hebrew, drops a letter now and then" },
  { file: "ggml-base.bin", mb: 148, hebrew: "rough Hebrew — gets short words wrong" },
  { file: "ggml-tiny.bin", mb: 75, hebrew: "poor Hebrew — short commands only" },
];

/** Models lighter than this one, in the order to try them. */
export function below(current) {
  const at = current ? LADDER.findIndex((m) => m.file.toLowerCase() === current.toLowerCase()) : -1;
  // Nothing configured: start at the second-lightest rather than at the top —
  // there is no point measuring a 1.6 GB model to find out it is slow.
  return LADDER.slice(at >= 0 ? at + 1 : LADDER.length - 2);
}

/**
 * Find the fastest model this computer can run inside targetMs.
 *
 * measure(modelPath) -> ms                 how long a sentence really takes
 * fetchModel(file, dest) -> void           download one, only when needed
 * exists(path) -> boolean
 *
 * Every step is reported through onStep so the caller can print it as it
 * happens; nothing is buffered until the end.
 */
export async function pickFastest({ current, speechDir, join, targetMs, measure, fetchModel, exists, onStep = () => {} }) {
  let before = null;
  if (current && exists(current)) {
    try {
      before = await measure(current);
      onStep({ kind: "measured", file: baseName(current), ms: before, ok: before <= targetMs });
    } catch (e) {
      onStep({ kind: "failed", file: baseName(current), error: e.message });
    }
  }
  if (before !== null && before <= targetMs) return { model: current, took: before, before, changed: false, tried: [] };

  const candidates = below(current ? baseName(current) : "");
  if (!candidates.length) return { model: current, took: before, before, changed: false, tried: [], atBottom: true };

  let best = before !== null ? { model: current, took: before, step: null } : null;
  const tried = [];
  for (const step of candidates) {
    const dest = join(speechDir, step.file);
    if (!exists(dest)) {
      onStep({ kind: "downloading", file: step.file, mb: step.mb });
      try {
        await fetchModel(step.file, dest);
      } catch (e) {
        onStep({ kind: "download_failed", file: step.file, error: e.message });
        continue;
      }
    }
    let took;
    try {
      took = await measure(dest);
    } catch (e) {
      onStep({ kind: "failed", file: step.file, error: e.message });
      continue;
    }
    tried.push({ file: step.file, ms: took });
    onStep({ kind: "measured", file: step.file, ms: took, ok: took <= targetMs, hebrew: step.hebrew });
    if (!best || took < best.took) best = { model: dest, took, step };
    // The first that keeps up wins: the heaviest model that is fast enough is
    // the most accurate one this computer can afford.
    if (took <= targetMs) break;
  }
  if (!best) return { model: null, took: null, before, changed: false, tried };
  return { model: best.model, took: best.took, step: best.step, before, changed: best.model !== current, tried };
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * What the installer should do with what the person typed at the menu.
 *
 * Kept here, next to the ladder, because it is the same decision seen from the
 * other side — and because the installer reads its answer from a terminal,
 * which a test cannot supply: with stdin piped there is no TTY and the prompt
 * returns nothing at all. The rule is worth covering, so it lives where it can
 * be called directly.
 *
 *   ""          keep what is in use
 *   a name on the menu, already downloaded   use it
 *   a name on the menu, not downloaded       download it, then use it
 *   anything else                            change nothing, and say so
 */
export function resolveChoice(want, currentFile, { exists, join, dir, models = LADDER, ids = {} }) {
  const answer = String(want ?? "").trim().toLowerCase();
  if (!answer) return { kind: "keep", file: currentFile };
  const model = models.find((m) => (ids[m.file] ?? m.file) === answer || m.file === answer || (m.id ?? "") === answer);
  if (!model) return { kind: "unknown", answer, file: currentFile };
  const file = join(dir, model.file);
  if (file === currentFile) return { kind: "keep", file: currentFile, model };
  return exists(file) ? { kind: "use", file, model } : { kind: "download", file, model };
}
