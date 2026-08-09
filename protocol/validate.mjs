/** @typedef {Record<string, unknown>} JsonSchema */

/** @param {unknown} value */
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** @param {unknown} value @param {string | string[]} expected */
function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return jsonType(value) === type;
  });
}

/**
 * Validate the deliberately small JSON-Schema 2020-12 subset used by protocol/v1.
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} path
 * @param {string[]} errors
 */
function visit(value, schema, path, errors) {
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} is not an allowed enum value`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      visit(value, /** @type {JsonSchema} */ (candidate), path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema`);
    return;
  }
  if (schema.type !== undefined) {
    const expected = /** @type {string | string[]} */ (schema.type);
    if (!matchesType(value, expected)) {
      errors.push(`${path} must have type ${Array.isArray(expected) ? expected.join("|") : expected}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} is shorter than minLength`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} is longer than maxLength`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} does not match pattern`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} is below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} is above maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} has too few items`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) =>
        visit(item, /** @type {JsonSchema} */ (schema.items), `${path}[${index}]`, errors),
      );
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = /** @type {Record<string, unknown>} */ (value);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in object)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? /** @type {Record<string, JsonSchema>} */ (schema.properties)
        : {};
    for (const [key, child] of Object.entries(object)) {
      if (properties[key]) {
        visit(child, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
}

/** @param {unknown} value @param {JsonSchema} schema */
export function validateProtocolValue(value, schema) {
  /** @type {string[]} */
  const errors = [];
  visit(value, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}

/** @param {unknown} value @param {JsonSchema} schema */
export function assertProtocolValue(value, schema) {
  const result = validateProtocolValue(value, schema);
  if (!result.ok) throw new Error(`protocol validation failed: ${result.errors.join("; ")}`);
  return value;
}
