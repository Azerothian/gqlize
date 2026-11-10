// Converting a CSV cell to the value a column of a given abstract type takes.
//
// For a surface with no typed input layer of its own to lean on — nestize,
// whose zod schemas expect a `number` for an `Int` and a `Date` for a `Date`.
// gqlize does not use this: it converts against the GraphQL input type the
// same field would be sent as, so a CSV cell is held to exactly what a JSON
// argument is.

import { DataType, type DataTypeDescriptor } from "@azerothian/utilize/types/index";

import { CsvUploadError } from "./errors";

const TRUE = new Set(["true", "1", "yes"]);
const FALSE = new Set(["false", "0", "no"]);

function invalid(raw: string, what: string): never {
  throw new CsvUploadError("CSV_ROW_INVALID", `${JSON.stringify(raw)} is not ${what}`);
}

/** A cell as a number, or a refusal — `Number("")` is `0`, which is not a reading of anything. */
export function csvNumber(raw: string, integer: boolean): number {
  const text = raw.trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    invalid(raw, integer ? "an integer" : "a number");
  }
  return n;
}

/** `true`/`false`, `1`/`0` or `yes`/`no`, in any case. */
export function csvBoolean(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (TRUE.has(text)) {
    return true;
  }
  if (FALSE.has(text)) {
    return false;
  }
  return invalid(raw, "a boolean");
}

/** A cell holding JSON — an array or JSON column, or a nested input. */
export function csvJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return invalid(raw, "valid JSON");
  }
}

/**
 * A cell holding a list — the value of an `in`, `notIn` or `between` filter.
 * A JSON array when it starts with `[`; otherwise the items between `|`s, so
 * `a|b|c` is what a spreadsheet user types. Each item is left as text for the
 * caller to convert by the list's item type.
 */
export function csvList(raw: string): unknown[] {
  if (raw.trimStart().startsWith("[")) {
    const value = csvJson(raw);
    return Array.isArray(value) ? value : invalid(raw, "a list");
  }
  return raw.split("|");
}

/**
 * The value a cell holds for a column of `descriptor`'s type. `null` (the
 * `\N` cell) stays `null`; an unknown or textual type keeps the string, for
 * the surface's own validation to judge.
 *
 * Throws a `CSV_ROW_INVALID` {@link CsvUploadError} with no row or column —
 * the caller knows both and adds them.
 */
export function csvCellValue(raw: string | null, descriptor: DataTypeDescriptor | undefined): unknown {
  if (raw === null || !descriptor) {
    return raw;
  }
  switch (descriptor.type) {
    case DataType.Int:
      return csvNumber(raw, true);
    case DataType.Float:
      return csvNumber(raw, false);
    case DataType.Boolean:
      return csvBoolean(raw);
    case DataType.Date:
    case DataType.DateOnly: {
      const date = new Date(raw.trim());
      return Number.isNaN(date.getTime()) ? invalid(raw, "a date") : date;
    }
    case DataType.Array:
    case DataType.JSON:
      return csvJson(raw);
    default:
      // BigInt and Decimal stay strings on purpose: that is how every other
      // surface carries them, to keep precision a JS number would lose.
      return raw;
  }
}
