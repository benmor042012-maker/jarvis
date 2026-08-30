// tools/calculator.js
// Safe calculator — evaluates simple math expressions locally, no eval().

export const calculator_def = {
  name: "calculator",
  description:
    "מחשבון בטוח למספרים ואופרטורים בסיסיים (+ - * / % ()). תומך גם ב-sqrt, pow, abs, log, sin, cos, tan, pi, e. לא משתמש ב-eval.",
  input_schema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "ביטוי מתמטי כמו '2+2*3' או 'sqrt(16)+pi'",
      },
    },
    required: ["expression"],
  },
};

export async function calculator({ expression }) {
  try {
    const value = safeEval(String(expression));
    if (!Number.isFinite(value)) return { error: "תוצאה לא סופית" };
    return { expression, result: value };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Minimal recursive-descent parser. Handles: numbers, +-*/%, parens,
// unary +/-, and a whitelist of function/constant names.
function safeEval(src) {
  const s = src.replace(/\s+/g, "");
  let i = 0;

  const CONSTS = { pi: Math.PI, e: Math.E };
  const FNS = {
    sqrt: Math.sqrt, abs: Math.abs, log: Math.log, ln: Math.log,
    log10: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    pow: Math.pow, min: Math.min, max: Math.max, exp: Math.exp,
  };

  function peek() { return s[i]; }
  function eat(c) { if (s[i] === c) { i++; return true; } return false; }
  function expect(c) { if (!eat(c)) throw new Error(`expected ${c}`); }

  function parseExpr() {
    let v = parseTerm();
    while (true) {
      if (eat("+")) v = v + parseTerm();
      else if (eat("-")) v = v - parseTerm();
      else break;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (true) {
      if (eat("*")) v = v * parseFactor();
      else if (eat("/")) v = v / parseFactor();
      else if (eat("%")) v = v % parseFactor();
      else break;
    }
    return v;
  }
  function parseFactor() {
    if (eat("+")) return parseFactor();
    if (eat("-")) return -parseFactor();
    return parsePow();
  }
  function parsePow() {
    const v = parseAtom();
    if (eat("^")) return Math.pow(v, parseFactor());
    return v;
  }
  function parseAtom() {
    if (eat("(")) {
      const v = parseExpr();
      expect(")");
      return v;
    }
    // number
    const numMatch = s.slice(i).match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch) { i += numMatch[0].length; return parseFloat(numMatch[0]); }
    // identifier
    const idMatch = s.slice(i).match(/^[a-z][a-z0-9_]*/);
    if (idMatch) {
      const name = idMatch[0];
      i += name.length;
      if (peek() === "(") {
        eat("(");
        const args = [];
        if (peek() !== ")") {
          args.push(parseExpr());
          while (eat(",")) args.push(parseExpr());
        }
        expect(")");
        const fn = FNS[name];
        if (!fn) throw new Error(`unknown function ${name}`);
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`unknown identifier ${name}`);
    }
    throw new Error(`unexpected character at ${i}: ${s[i]}`);
  }

  const v = parseExpr();
  if (i !== s.length) throw new Error(`unexpected trailing input at ${i}`);
  return v;
}
