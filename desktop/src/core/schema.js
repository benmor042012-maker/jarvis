// Minimal JSON-schema-like validator. Supports the subset the tool registry
// uses: object/string/number/integer/boolean/array, enum, min/max, pattern,
// required, additionalProperties (false by default for tool params).

class SchemaError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SchemaError";
    this.path = path;
  }
}

function validate(schema, value, path = "") {
  if (!schema) return value;
  const type = schema.type;
  if (value === undefined || value === null) {
    if (schema.default !== undefined) return schema.default;
    if (schema.nullable) return null;
    throw new SchemaError("is required", path || "value");
  }
  if (type === "string") {
    if (typeof value !== "string") throw new SchemaError("must be a string", path);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new SchemaError(`must be at least ${schema.minLength} characters`, path);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new SchemaError(`must be at most ${schema.maxLength} characters`, path);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new SchemaError("has an invalid format", path);
    if (schema.enum && !schema.enum.includes(value)) throw new SchemaError(`must be one of ${schema.enum.join(", ")}`, path);
    return value;
  }
  if (type === "number" || type === "integer") {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new SchemaError("must be a number", path);
    if (type === "integer" && !Number.isInteger(n)) throw new SchemaError("must be an integer", path);
    if (schema.minimum !== undefined && n < schema.minimum) throw new SchemaError(`must be >= ${schema.minimum}`, path);
    if (schema.maximum !== undefined && n > schema.maximum) throw new SchemaError(`must be <= ${schema.maximum}`, path);
    if (schema.enum && !schema.enum.includes(n)) throw new SchemaError(`must be one of ${schema.enum.join(", ")}`, path);
    return n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new SchemaError("must be true or false", path);
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new SchemaError("must be a list", path);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new SchemaError(`needs at least ${schema.minItems} items`, path);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new SchemaError(`allows at most ${schema.maxItems} items`, path);
    return value.map((v, i) => (schema.items ? validate(schema.items, v, `${path}[${i}]`) : v));
  }
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) throw new SchemaError("must be an object", path);
    const props = schema.properties || {};
    const out = {};
    for (const [key, sub] of Object.entries(props)) {
      const v = value[key];
      const required = (schema.required || []).includes(key);
      if (v === undefined || v === null) {
        if (required) throw new SchemaError("is required", path ? `${path}.${key}` : key);
        if (sub.default !== undefined) out[key] = sub.default;
        continue;
      }
      out[key] = validate(sub, v, path ? `${path}.${key}` : key);
    }
    if (schema.additionalProperties === true) {
      for (const [k, v] of Object.entries(value)) if (!(k in props)) out[k] = v;
    } else {
      for (const k of Object.keys(value)) {
        if (!(k in props)) throw new SchemaError(`unknown field '${k}'`, path);
      }
    }
    return out;
  }
  return value;
}

module.exports = { validate, SchemaError };
