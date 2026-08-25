// Typed JSON (de)serialization driven by field descriptors, so values round-trip
// through Redis strings without losing types JSON can't represent natively
// (Date, BigInt, Buffer). Fields with no descriptor pass through untouched.

import { DataType, DataTypeDescriptor } from "@azerothian/utilize/types/data-type";

type FieldMeta = { type?: DataTypeDescriptor };
type FieldMap = { [name: string]: FieldMeta };

function encodeField(desc: DataTypeDescriptor | undefined, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (desc?.type) {
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      return value instanceof Date ? value.toISOString() : value;
    case DataType.BigInt:
      if (typeof value === "bigint") return value.toString();
      // A BigInt-typed field's value is otherwise a number/string/boolean by
      // construction — never a plain object with no meaningful string form. A
      // cast here would be flagged as unnecessary (`String`'s parameter is
      // `any`), so the invariant is documented instead.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment above
      return String(value);
    case DataType.Decimal:
      // Same invariant as above: a Decimal-typed field's value is a
      // number/string/boolean.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment above
      return String(value);
    case DataType.Blob:
      return Buffer.isBuffer(value) ? value.toString("base64") : value;
    default:
      return value; // String / Int / Float / Boolean / JSON / Array / Enum / UUID
  }
}

function decodeField(desc: DataTypeDescriptor | undefined, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (desc?.type) {
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      // Encoded above as an ISO string, or left as a numeric timestamp — both are
      // what `Date`'s constructor accepts.
      return new Date(value as string | number);
    case DataType.BigInt:
      // Encoded above as a string; `BigInt` also accepts number/boolean.
      return BigInt(value as string | number | boolean);
    case DataType.Blob:
      // Encoded above as a base64 string.
      return Buffer.from(value as string, "base64");
    case DataType.Int:
      if (typeof value === "number") return value;
      // Same invariant as the BigInt/Decimal cases above.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment on the BigInt case above
      return parseInt(String(value), 10);
    case DataType.Float:
      if (typeof value === "number") return value;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment on the BigInt case above
      return parseFloat(String(value));
    default:
      return value; // Decimal stays a string for precision
  }
}

export function serialize(fields: FieldMap, obj: { [k: string]: unknown }): string {
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(obj)) {
    out[k] = encodeField(fields[k]?.type, obj[k]);
  }
  return JSON.stringify(out);
}

/**
 * Decode a stored row.
 *
 * `TRow` lets a caller name the shape it knows it stored — `deserialize<Task>(…)`
 * — instead of the `any` this used to return, which put an unchecked value into
 * every call site by default. It defaults to an index signature, so callers that
 * pass nothing keep working and simply get a value they must narrow. Like any
 * deserializer the parameter is an assertion, not a check: what comes back is
 * whatever was serialized.
 *
 * Overloaded so a caller that has already narrowed `json` to a plain `string`
 * (e.g. having checked it non-null itself) gets a non-null return type back,
 * without a cast at the call site.
 */
export type ValkeyStoredRow = { [k: string]: unknown };
export function deserialize<TRow extends ValkeyStoredRow = ValkeyStoredRow>(fields: FieldMap, json: string): TRow;
export function deserialize<TRow extends ValkeyStoredRow = ValkeyStoredRow>(fields: FieldMap, json: string | null): TRow | null;
export function deserialize<TRow extends ValkeyStoredRow = ValkeyStoredRow>(fields: FieldMap, json: string | null): TRow | null {
  if (json === null || json === undefined) {
    return null;
  }
  const raw = JSON.parse(json);
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(raw)) {
    out[k] = decodeField(fields[k]?.type, raw[k]);
  }
  // The one assertion the generic buys: `TRow` describes what the caller stored,
  // which this function cannot verify — see the doc comment.
  return out as TRow;
}
