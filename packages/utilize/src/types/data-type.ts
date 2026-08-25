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
