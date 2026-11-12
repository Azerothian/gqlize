// Checks the params a caller hands an instance-method transform against the
// `args` its `expose.instanceMethods.mutations` entry declares, the way gqlize's
// `apply` input type checks them. gqlize gets that from graphql's own variable
// coercion; nestize and temporalize call this, so a transform sees the same
// params whichever surface ran it.
//
// GraphQL-free: the declared `args` hold GraphQL types, but this package must
// not import graphql. They are recognised by the `Symbol.toStringTag` graphql-js
// gives every type class, and leaf values are coerced by the type's own
// `coerceInputValue`/`parseValue`, so custom scalars and enums keep their rules.

import type { ExposedMethod } from "./types/index";

/** The result of {@link coerceTransformParams}: the params to run with, or why they were refused. */
export type TransformParamsResult = { ok: true; value: unknown } | { ok: false; message: string };

type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a GraphQL input type, read structurally (see the header).
type InputType = any;

const tag = (type: InputType): string => (type ? Object.prototype.toString.call(type).slice(8, -1) : "");

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

const fail = (path: string, message: string): Coerced => ({ ok: false, message: `${path}: ${message}` });

/** A map of input fields (an arg map, or an input object's fields) against a plain object. */
function coerceFields(
  fields: { [name: string]: { type: InputType; defaultValue?: unknown } },
  value: unknown,
  path: string,
): Coerced {
  if (!isPlainObject(value)) {
    return fail(path, "expected an object");
  }
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && !Object.hasOwn(fields, key)) {
      return fail(path, `unknown argument "${key}"`);
    }
  }
  const out: { [key: string]: unknown } = {};
  for (const name of Object.keys(fields)) {
    const field = fields[name];
    const given = Object.hasOwn(value, name) ? value[name] : undefined;
    if (given === undefined) {
      if (tag(field.type) === "GraphQLNonNull" && field.defaultValue === undefined) {
        return fail(`${path}.${name}`, "is required");
      }
      if (field.defaultValue !== undefined) {
        out[name] = field.defaultValue;
      }
      continue;
    }
    const coerced = coerceValue(field.type, given, `${path}.${name}`);
    if (!coerced.ok) {
      return coerced;
    }
    out[name] = coerced.value;
  }
  return { ok: true, value: out };
}

function coerceValue(type: InputType, value: unknown, path: string): Coerced {
  switch (tag(type)) {
    case "GraphQLNonNull":
      return value === null ? fail(path, "must not be null") : coerceValue(type.ofType, value, path);
    case "GraphQLList": {
      if (value === null) {
        return { ok: true, value: null };
      }
      const items = Array.isArray(value) ? value : [value];
      const out: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        const coerced = coerceValue(type.ofType, items[i], `${path}[${i}]`);
        if (!coerced.ok) {
          return coerced;
        }
        out.push(coerced.value);
      }
      return { ok: true, value: out };
    }
    case "GraphQLInputObjectType": {
      if (value === null) {
        return { ok: true, value: null };
      }
      const coerced = coerceFields(type.getFields(), value, path);
      if (coerced.ok && type.isOneOf) {
        const keys = Object.keys(coerced.value as object);
        if (keys.length !== 1 || (coerced.value as { [k: string]: unknown })[keys[0]] === null) {
          return fail(path, "must set exactly one field");
        }
      }
      return coerced;
    }
    case "GraphQLScalarType":
    case "GraphQLEnumType": {
      if (value === null) {
        return { ok: true, value: null };
      }
      const coerce = (type.coerceInputValue ?? type.parseValue) as ((v: unknown) => unknown) | undefined;
      try {
        const parsed = coerce?.call(type, value);
        return parsed === undefined ? fail(path, `not a valid ${type.name}`) : { ok: true, value: parsed };
      } catch (e) {
        return fail(path, e instanceof Error ? e.message : `not a valid ${type.name}`);
      }
    }
    default:
      // An arg declared with something that is not a GraphQL input type would
      // not build in gqlize either; refuse rather than pass the value through.
      return fail(path, "has no input type to check it against");
  }
}

/**
 * The params `method` runs with, checked and coerced against its declared
 * `args`, or the reason they were refused.
 *
 * - `null`, `false` and `undefined` mean "not asked for" and come back as given.
 * - A transform with no `args` takes `true` (an empty object is read as `true`,
 *   the body a bare REST call sends). Anything else is refused: gqlize types such
 *   a transform as `Boolean`, so it can't be handed params there either.
 * - A transform with `args` takes an object of them (`true` is read as `{}`).
 *   Unknown keys are refused, required args must be present, defaults fill in,
 *   and every value is coerced by its declared type.
 */
export function coerceTransformParams(method: ExposedMethod, params: unknown, name = "params"): TransformParamsResult {
  if (params === undefined || params === null || params === false) {
    return { ok: true, value: params };
  }
  const args = (method.args || {}) as { [name: string]: { type: InputType; defaultValue?: unknown } };
  if (Object.keys(args).length === 0) {
    if (params === true || (isPlainObject(params) && Object.keys(params).length === 0)) {
      return { ok: true, value: true };
    }
    return { ok: false, message: `${name}: takes no arguments` };
  }
  return coerceFields(args, params === true ? {} : params, name);
}
