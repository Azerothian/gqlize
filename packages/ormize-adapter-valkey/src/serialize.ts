// Typed JSON (de)serialization driven by field descriptors, so values round-trip
// through Redis strings without losing types JSON can't represent natively
// (Date, BigInt, Buffer). Fields with no descriptor pass through untouched.

import { DataType, DataTypeDescriptor } from "@azerothian/utilize/types/data-type";

type FieldMeta = { type?: DataTypeDescriptor };
type FieldMap = { [name: string]: FieldMeta };

function encodeField(desc: DataTypeDescriptor | undefined, value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  switch (desc?.type) {
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      return value instanceof Date ? value.toISOString() : value;
    case DataType.BigInt:
      return typeof value === "bigint" ? value.toString() : String(value);
    case DataType.Decimal:
      return String(value);
    case DataType.Blob:
      return Buffer.isBuffer(value) ? value.toString("base64") : value;
    default:
      return value; // String / Int / Float / Boolean / JSON / Array / Enum / UUID
  }
}

function decodeField(desc: DataTypeDescriptor | undefined, value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  switch (desc?.type) {
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      return new Date(value);
    case DataType.BigInt:
      return BigInt(value);
    case DataType.Blob:
      return Buffer.from(value, "base64");
    case DataType.Int:
      return typeof value === "number" ? value : parseInt(value, 10);
    case DataType.Float:
      return typeof value === "number" ? value : parseFloat(value);
    default:
      return value; // Decimal stays a string for precision
  }
}

export function serialize(fields: FieldMap, obj: { [k: string]: any }): string {
  const out: { [k: string]: any } = {};
  for (const k of Object.keys(obj)) {
    out[k] = encodeField(fields[k]?.type, obj[k]);
  }
  return JSON.stringify(out);
}

export function deserialize(fields: FieldMap, json: string | null): any {
  if (json === null || json === undefined) {
    return null;
  }
  const raw = JSON.parse(json);
  const out: { [k: string]: any } = {};
  for (const k of Object.keys(raw)) {
    out[k] = decodeField(fields[k]?.type, raw[k]);
  }
  return out;
}
