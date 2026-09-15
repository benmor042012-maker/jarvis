const test = require("node:test");
const assert = require("node:assert/strict");
const { canonical, paramsHash, redact, isPrivateHost, timingEqual } = require("../src/core/util");
const { validate, SchemaError } = require("../src/core/schema");

test("canonical JSON sorts keys and ignores undefined", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, 2], c: undefined } }), '{"a":{"d":[1,2]},"b":1}');
  assert.equal(paramsHash({ x: 1, y: 2 }), paramsHash({ y: 2, x: 1 }));
  assert.notEqual(paramsHash({ x: 1 }), paramsHash({ x: 2 }));
});

test("redact masks secret keys and values", () => {
  const r = redact({ api_key: "abc", nested: { password: "x", ok: "sk-1234567890abcdef" }, list: ["Bearer abcdefghijk"] });
  assert.equal(r.api_key, "***");
  assert.equal(r.nested.password, "***");
  assert.equal(r.nested.ok, "***");
  assert.equal(r.list[0], "***");
});

test("private host detection", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "::1", "pc.local"]) assert.ok(isPrivateHost(h), h);
  for (const h of ["api.openai.com", "8.8.8.8", "172.32.0.1", "example.com"]) assert.ok(!isPrivateHost(h), h);
});

test("timingEqual", () => {
  assert.ok(timingEqual("abc", "abc"));
  assert.ok(!timingEqual("abc", "abd"));
  assert.ok(!timingEqual("abc", "abcd"));
  assert.ok(!timingEqual(null, "abc"));
});

test("schema validator enforces types, enums, ranges and unknown fields", () => {
  const s = { type: "object", properties: { x: { type: "integer", minimum: 0, maximum: 10 }, mode: { type: "string", enum: ["a", "b"], default: "a" }, list: { type: "array", items: { type: "string" }, maxItems: 2 } }, required: ["x"] };
  assert.deepEqual(validate(s, { x: "3" }), { x: 3, mode: "a" });
  assert.throws(() => validate(s, {}), SchemaError);
  assert.throws(() => validate(s, { x: 11 }), /<= 10/);
  assert.throws(() => validate(s, { x: 1, mode: "z" }), /one of/);
  assert.throws(() => validate(s, { x: 1, extra: true }), /unknown field/);
  assert.throws(() => validate(s, { x: 1, list: ["a", "b", "c"] }), /at most 2/);
  assert.throws(() => validate(s, { x: 1.5 }), /integer/);
});
