// Abstract <-> MikroORM type mapping.
//
// The "native type" on this backend is a MikroORM `EntityProperty` — which is
// where the type lives, together with the enum members, the array flag and the
// column types the platform resolved. `mapDataType` classifies one; `toNativeType`
// names the MikroORM type string that would produce it.

import { DataType, DataTypes, type DataTypeDescriptor } from "@azerothian/utilize/types/data-type";
import type { NativeDataType } from "@azerothian/utilize/types/index";

/**
 * As much of a MikroORM `EntityProperty` as the mapping reads.
 *
 * Structural rather than imported: the real property type is generic in the
 * owner and target entities, and this layer only ever sees it through the
 * contract's opaque {@link NativeDataType}.
 */
export interface MikroNativeType {
  type?: string;
  runtimeType?: string;
  array?: boolean;
  enum?: boolean;
  items?: (string | number)[];
  columnTypes?: string[];
}

/**
 * The type strings MikroORM resolves to, grouped by the abstract type they mean.
 *
 * Matched case-insensitively and after the length/precision suffix is stripped,
 * so `varchar(255)` and `VARCHAR` both land on `String` — the platform decides
 * how much of that suffix survives into `type`, and it differs by driver.
 */
const BY_NAME: { [name: string]: DataTypeDescriptor } = {
  string: DataTypes.String, varchar: DataTypes.String, char: DataTypes.String,
  character: DataTypes.String, text: DataTypes.String, tinytext: DataTypes.String,
  mediumtext: DataTypes.String, longtext: DataTypes.String, citext: DataTypes.String,
  ntext: DataTypes.String, nvarchar: DataTypes.String,

  uuid: DataTypes.UUID, uniqueidentifier: DataTypes.UUID,

  number: DataTypes.Int, int: DataTypes.Int, integer: DataTypes.Int,
  smallint: DataTypes.Int, tinyint: DataTypes.Int, mediumint: DataTypes.Int,
  int2: DataTypes.Int, int4: DataTypes.Int, serial: DataTypes.Int, smallserial: DataTypes.Int,

  bigint: DataTypes.BigInt, int8: DataTypes.BigInt, bigserial: DataTypes.BigInt,

  float: DataTypes.Float, float4: DataTypes.Float, float8: DataTypes.Float,
  double: DataTypes.Float, doubleprecision: DataTypes.Float, real: DataTypes.Float,

  decimal: DataTypes.Decimal, numeric: DataTypes.Decimal, money: DataTypes.Decimal,

  boolean: DataTypes.Boolean, bool: DataTypes.Boolean, bit: DataTypes.Boolean,

  datetime: DataTypes.Date, timestamp: DataTypes.Date, timestamptz: DataTypes.Date,
  date: DataTypes.DateOnly, dateonly: DataTypes.DateOnly,
  time: DataTypes.Time, timetz: DataTypes.Time,

  json: DataTypes.JSON, jsonb: DataTypes.JSON, object: DataTypes.JSON,

  blob: DataTypes.Blob, buffer: DataTypes.Blob, bytea: DataTypes.Blob,
  binary: DataTypes.Blob, varbinary: DataTypes.Blob, uint8array: DataTypes.Blob,
};

/**
 * `varchar(255)` / `numeric(10, 2)` / `TIMESTAMP WITH TIME ZONE` -> the bare name
 * the table above is keyed on.
 */
function normalise(name: string): string {
  return name
    .split("(")[0]
    .replace(/\s+with(out)?\s+time\s+zone/i, "")
    .replace(/[\s_-]/g, "")
    .toLowerCase();
}

/** `string[]` / `Date[]` -> the element's own name, or `undefined` if not an array spelling. */
function elementName(name: string): string | undefined {
  const m = /^(.*?)\s*\[\]$/.exec(name);
  return m ? m[1] : undefined;
}

function fromName(name: string | undefined): DataTypeDescriptor {
  if (!name) {
    return DataTypes.Unknown;
  }
  const element = elementName(name);
  if (element) {
    return DataTypes.Array(fromName(element));
  }
  // Unknown rather than a guess, and never a throw: one column this mapping has
  // not met must not take the whole schema down with it. It still gets a field —
  // `type-mapper` renders an unknown as `String`.
  return BY_NAME[normalise(name)] || DataTypes.Unknown;
}

/**
 * Classify a MikroORM property into an abstract {@link DataTypeDescriptor}.
 *
 * `type` first, then `runtimeType`, then the platform's resolved `columnTypes`:
 * `type` is what the author declared and is the most specific (it separates
 * `date` from `datetime`, which `runtimeType` flattens to `Date`), and
 * `columnTypes` is the last resort for a property whose type was only ever
 * inferred from the database.
 */
export function mapDataType(nativeType: NativeDataType): DataTypeDescriptor {
  const prop = nativeType as MikroNativeType | string | undefined;
  if (typeof prop === "string") {
    return fromName(prop);
  }
  if (!prop) {
    return DataTypes.Unknown;
  }
  // An enum is an enum whatever its column type says, so this is tested first.
  if (prop.enum && prop.items && prop.items.length > 0) {
    return DataTypes.Enum(...prop.items.map((v) => String(v)));
  }
  const resolved = [prop.type, prop.runtimeType, prop.columnTypes?.[0]]
    .map(fromName)
    .find((d) => d.type !== DataType.Unknown) || DataTypes.Unknown;
  // `array: true` is MikroORM's own flag for a scalar array column; the `T[]`
  // spelling is handled inside `fromName`, so only wrap what is not already one.
  return prop.array && resolved.type !== DataType.Array ? DataTypes.Array(resolved) : resolved;
}

/**
 * The MikroORM type string for an abstract descriptor — the inverse direction,
 * used by consumers that project an ormize instance rather than query it
 * (`@azerothian/ormize-zod4`).
 *
 * An enum reports `string`: MikroORM carries its members in `items`, not in the
 * type name, and a name is all this function can return.
 */
export function toNativeType(descriptor: DataTypeDescriptor): NativeDataType {
  switch (descriptor?.type) {
    case DataType.Int: return "integer";
    case DataType.BigInt: return "bigint";
    case DataType.Float: return "double";
    case DataType.Decimal: return "decimal";
    case DataType.Boolean: return "boolean";
    case DataType.Date: return "datetime";
    case DataType.DateOnly: return "date";
    case DataType.Time: return "time";
    case DataType.UUID: return "uuid";
    case DataType.JSON: return "json";
    case DataType.Blob: return "blob";
    // Every branch above returns a string, so the recursion does too; the
    // contract types the return as the opaque `NativeDataType` all the same.
    case DataType.Array: return `${toNativeType(descriptor.element || DataTypes.Unknown) as string}[]`;
    default: return "string";
  }
}
