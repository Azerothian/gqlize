import { z } from "zod";
import { DataType } from "@azerothian/ormize";
import type { FieldValidators } from "@azerothian/utilize";

// Translate a Sequelize `validate` block into Zod refinements. Best-effort: a
// documented common subset is mapped; unknown validators are ignored (never
// throw), so generated schemas stay permissive rather than wrong.

/** The `{args}` wrapper Sequelize accepts around a validator's value. */
type ArgsWrapper = { args?: unknown };

/** `v.args` if `v` is the wrapper form, otherwise `undefined`. */
function argsOf(v: unknown): unknown {
  return typeof v === "object" && v !== null ? (v as ArgsWrapper).args : undefined;
}

/** Normalize a sequelize validator value to a number (handles `n`, `{args:[n]}`, `[n]`). */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  const args = argsOf(v);
  if (Array.isArray(args)) return toNumber(args[0]);
  if (Array.isArray(v)) return toNumber(v[0]);
  return undefined;
}

/** Normalize `len` to `[min?, max?]` (handles `[min,max]`, `{args:[min,max]}`, `{args:[[min,max]]}`). */
function lenBounds(v: unknown): [number | undefined, number | undefined] {
  const args = argsOf(v);
  let a: unknown[] = Array.isArray(v) ? v : Array.isArray(args) ? args : [];
  if (Array.isArray(a[0])) a = a[0];
  return [toNumber(a[0]), toNumber(a[1])];
}

/** Regex source (handles `is: /re/`, `is: "re"`, `is: { args: [/re/] }`). */
function regexOf(v: unknown): RegExp | undefined {
  const args = argsOf(v);
  // Indexed rather than `Array.isArray`-guarded so the wrapper form behaves
  // exactly as it did untyped: any truthy `args` is indexed at 0.
  const raw = !Array.isArray(v) && args ? (args as Record<number, unknown>)[0] : v;
  if (raw instanceof RegExp) return raw;
  if (typeof raw === "string") {
    try {
      return new RegExp(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  // Sequelize enables a flag validator with `true` or `{ msg }`.
  return v === true || (typeof v === "object" && v !== null);
}

/**
 * Apply translated validators to a base Zod schema. Only string/number bases are
 * refined; other types are returned unchanged.
 */
export function applyValidators(schema: z.ZodTypeAny, validate: FieldValidators | undefined, baseType: DataType): z.ZodTypeAny {
  if (!validate || typeof validate !== "object") return schema;

  const isStringBase = baseType === DataType.String || baseType === DataType.BigInt || baseType === DataType.Decimal;
  const isNumberBase = baseType === DataType.Int || baseType === DataType.Float;

  if (isStringBase) {
    let s = schema as z.ZodString;
    for (const key of Object.keys(validate)) {
      const val = validate[key];
      switch (key) {
        case "len": {
          const [min, max] = lenBounds(val);
          if (typeof min === "number") s = s.min(min);
          if (typeof max === "number") s = s.max(max);
          break;
        }
        case "notEmpty":
          if (truthy(val)) s = s.min(1);
          break;
        case "isEmail":
          if (truthy(val)) s = s.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
          break;
        case "isAlphanumeric":
          if (truthy(val)) s = s.regex(/^[a-z0-9]+$/i);
          break;
        case "isNumeric":
          if (truthy(val)) s = s.regex(/^[0-9]+$/);
          break;
        case "isUrl":
          if (truthy(val)) s = s.regex(/^https?:\/\/[^\s]+$/i);
          break;
        case "isUUID":
          if (truthy(val)) s = s.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          break;
        case "is": {
          const re = regexOf(val);
          if (re) s = s.regex(re);
          break;
        }
        default:
          break; // unknown validator — ignore
      }
    }
    return s;
  }

  if (isNumberBase) {
    let n = schema as z.ZodNumber;
    for (const key of Object.keys(validate)) {
      const val = validate[key];
      switch (key) {
        case "min": {
          const m = toNumber(val);
          if (typeof m === "number") n = n.min(m);
          break;
        }
        case "max": {
          const m = toNumber(val);
          if (typeof m === "number") n = n.max(m);
          break;
        }
        default:
          break;
      }
    }
    return n;
  }

  return schema;
}
