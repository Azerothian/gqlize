// Abstract, adapter-agnostic data-type system for ormize.
//
// Two directions:
//  - read:  a live adapter-native type (e.g. a Sequelize DataType instance) is
//           classified into a `DataTypeDescriptor` by `OrmAdapter.mapDataType`.
//  - write: a definition may author `type: DataTypes.String` (an abstract token,
//           also a `DataTypeDescriptor`) which the adapter converts back to its
//           native type via `OrmAdapter.toNativeType`. Native types authored the
//           old way (e.g. `Sequelize.STRING`) pass through unchanged.
//
// GraphQL-free: a plain enum + branded plain objects, nothing else. This lets
// `@azerothian/ormize` and consumers like `@azerothian/ormize-zod4` reason about
// field types without importing `graphql` or `sequelize`.

/** Abstract type discriminator returned by `mapDataType` / carried by tokens. */
export enum DataType {
  String = "String",
  Int = "Int",
  Float = "Float",
  Boolean = "Boolean",
  BigInt = "BigInt",
  Decimal = "Decimal",
  Date = "Date",
  DateOnly = "DateOnly",
  Time = "Time",
  UUID = "UUID",
  Enum = "Enum",
  Array = "Array",
  JSON = "JSON",
  Blob = "Blob",
  Unknown = "Unknown",
}

/**
 * Brand marking an object as an ormize abstract type token/descriptor, so the
 * adapter can tell it apart from a native (e.g. Sequelize) DataType at runtime.
 * `Symbol.for` keeps it stable across module/realm boundaries.
 */
export const ORMIZE_DATATYPE: unique symbol = Symbol.for("ormize.datatype");

/** A branded, adapter-agnostic description of a field's type. */
export type DataTypeDescriptor = {
  readonly [ORMIZE_DATATYPE]: true;
  type: DataType;
  /** Members for `DataType.Enum`. */
  values?: string[];
  /** Element type for `DataType.Array`. */
  element?: DataTypeDescriptor;
};

/** Runtime guard: is `x` an ormize abstract type token/descriptor (not a native type)? */
export function isOrmizeDataType(x: unknown): x is DataTypeDescriptor {
  return !!x && typeof x === "object" && (x as {[ORMIZE_DATATYPE]?: unknown})[ORMIZE_DATATYPE] === true;
}

function desc(type: DataType, extra?: Omit<DataTypeDescriptor, typeof ORMIZE_DATATYPE | "type">): DataTypeDescriptor {
  return { [ORMIZE_DATATYPE]: true, type, ...(extra || {}) };
}

/**
 * Authorable abstract type tokens — parallels `Sequelize.DataTypes`. Use in a
 * definition as `type: DataTypes.String` / `DataTypes.Enum("a", "b")` /
 * `DataTypes.Array(DataTypes.Int)`. The adapter converts these to native types
 * when the model is built.
 */
export const DataTypes = {
  String: desc(DataType.String),
  Int: desc(DataType.Int),
  Float: desc(DataType.Float),
  Boolean: desc(DataType.Boolean),
  BigInt: desc(DataType.BigInt),
  Decimal: desc(DataType.Decimal),
  Date: desc(DataType.Date),
  DateOnly: desc(DataType.DateOnly),
  Time: desc(DataType.Time),
  UUID: desc(DataType.UUID),
  JSON: desc(DataType.JSON),
  Blob: desc(DataType.Blob),
  Unknown: desc(DataType.Unknown),
  Enum: (...values: string[]): DataTypeDescriptor => desc(DataType.Enum, { values }),
  Array: (element: DataTypeDescriptor): DataTypeDescriptor => desc(DataType.Array, { element }),
} as const;

/**
 * The abstract token a bare JavaScript constructor stands for, when a definition
 * authors `field: String` rather than `field: DataTypes.String`.
 *
 * Backend-neutral by construction, and shared so that it stays that way. The
 * valkey adapter accepted these and the sequelize adapter did not, so the same
 * definition was portable on one backend and quietly broken on the other:
 * sequelize passed the constructor through to `sequelize.define`, whose
 * `normalizeDataType` does `new Type()` and produces a `String` wrapper object
 * with no `.key` — not a valid DataType, and it fails late in DDL generation
 * rather than at define time, where the mistake would be obvious.
 *
 * `Number` maps to `Int` rather than `Float`: JavaScript has one numeric type
 * and no way to say which was meant, and a column silently widened to floating
 * point loses precision on ids. An author who wants a float says so.
 */
export function constructorDataType(value: unknown): DataTypeDescriptor | undefined {
  switch (value) {
    case String: return DataTypes.String;
    case Number: return DataTypes.Int;
    case Boolean: return DataTypes.Boolean;
    case Date: return DataTypes.Date;
    case BigInt: return DataTypes.BigInt;
    case Array: return DataTypes.Array(DataTypes.Unknown);
    case Object: return DataTypes.JSON;
    default: return undefined;
  }
}

/**
 * An authored field type as an abstract token, whatever spelling was used: an
 * ormize token passes through, a bare constructor is translated, and anything
 * else — a live backend type such as `Sequelize.STRING` — is not ours to
 * classify and comes back `undefined` for the adapter to handle natively.
 */
export function authoredDataType(value: unknown): DataTypeDescriptor | undefined {
  return isOrmizeDataType(value) ? value : constructorDataType(value);
}
