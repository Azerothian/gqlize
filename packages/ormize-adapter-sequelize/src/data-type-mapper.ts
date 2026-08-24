// Bridges Sequelize DataTypes <-> the abstract ormize `DataType` system.
//
//  - mapDataType:  native Sequelize DataType instance -> abstract DataTypeDescriptor (read path)
//  - toNativeType: abstract DataTypeDescriptor (authored token) -> native Sequelize DataType (write path)
//
// Discrimination mirrors the groupings in `./type-mapper.ts` (native -> GraphQL),
// but uses the cheaper `.key` string rather than `instanceof`.

import { DataTypes as SequelizeDataTypes, type DataType as SequelizeDataType } from "sequelize";
import {
  DataType,
  DataTypeDescriptor,
  DataTypes,
} from "@azerothian/utilize/types/data-type";
import type { NativeDataType } from "@azerothian/utilize/types/index";

/**
 * A native Sequelize type as this module produces one. Sequelize's own
 * `DataType` also admits a raw SQL string; `toNativeType` never returns that
 * form, and excluding it is what lets its result feed straight back into
 * `DataTypes.ARRAY(...)`.
 */
export type NativeSequelizeType = Exclude<SequelizeDataType, string>;

/**
 * The members this module reads off a native Sequelize DataType. A
 * {@link NativeDataType} is opaque by contract, so the narrowing happens here,
 * once, rather than at each `switch` arm — and the list doubles as the record of
 * exactly how much of Sequelize's internal DataType shape this depends on.
 */
type NativeTypeShape = {
  key?: unknown;
  /** ENUM's declared members. */
  values?: unknown;
  /** ARRAY's element type. */
  type?: NativeDataType;
  /** VIRTUAL's declared return type. */
  returnType?: NativeDataType;
  constructor?: { key?: unknown };
};

function shapeOf(nativeType: NativeDataType): NativeTypeShape {
  return (nativeType ?? {}) as NativeTypeShape;
}

function keyOf(nativeType: NativeDataType): string {
  const t = shapeOf(nativeType);
  const k = t.key ?? t.constructor?.key;
  return typeof k === "string" ? k.toUpperCase() : "";
}

/** Read: classify a live Sequelize DataType instance into an abstract descriptor. */
export function mapDataType(nativeType: NativeDataType): DataTypeDescriptor {
  const native = shapeOf(nativeType);
  switch (keyOf(nativeType)) {
    case "BOOLEAN":
      return DataTypes.Boolean;
    case "INTEGER":
      return DataTypes.Int;
    case "FLOAT":
    case "REAL":
    case "DOUBLE":
    case "DOUBLE PRECISION":
      return DataTypes.Float;
    case "BIGINT":
      return DataTypes.BigInt;
    case "DECIMAL":
      return DataTypes.Decimal;
    case "DATE":
      return DataTypes.Date;
    case "DATEONLY":
      return DataTypes.DateOnly;
    case "TIME":
      return DataTypes.Time;
    case "UUID":
    case "UUIDV4":
      return DataTypes.UUID;
    case "CHAR":
    case "STRING":
    case "TEXT":
    case "MACADDR":
    case "CIDR":
    case "INET":
      return DataTypes.String;
    case "ENUM":
      return DataTypes.Enum(...(Array.isArray(native.values) ? (native.values as string[]) : []));
    case "ARRAY":
      return DataTypes.Array(mapDataType(native.type));
    case "VIRTUAL":
      return native.returnType ? mapDataType(native.returnType) : DataTypes.String;
    case "JSON":
    case "JSONB":
    case "GEOMETRY":
      return DataTypes.JSON;
    case "BLOB":
      return DataTypes.Blob;
    default:
      // Resilient: unknown/unsupported native types classify as Unknown so
      // schema generation can still proceed rather than throwing.
      return DataTypes.Unknown;
  }
}

/** Write: convert an authored abstract descriptor into a native Sequelize DataType. */
export function toNativeType(descriptor: DataTypeDescriptor): NativeSequelizeType {
  switch (descriptor.type) {
    case DataType.String:
      return SequelizeDataTypes.STRING;
    case DataType.Int:
      return SequelizeDataTypes.INTEGER;
    case DataType.Float:
      return SequelizeDataTypes.FLOAT;
    case DataType.Boolean:
      return SequelizeDataTypes.BOOLEAN;
    case DataType.BigInt:
      return SequelizeDataTypes.BIGINT;
    case DataType.Decimal:
      return SequelizeDataTypes.DECIMAL;
    case DataType.Date:
      return SequelizeDataTypes.DATE;
    case DataType.DateOnly:
      return SequelizeDataTypes.DATEONLY;
    case DataType.Time:
      return SequelizeDataTypes.TIME;
    case DataType.UUID:
      return SequelizeDataTypes.UUID;
    case DataType.JSON:
      return SequelizeDataTypes.JSON;
    case DataType.Blob:
      return SequelizeDataTypes.BLOB;
    case DataType.Enum:
      return SequelizeDataTypes.ENUM(...((descriptor.values as string[]) || []));
    case DataType.Array:
      return SequelizeDataTypes.ARRAY(
        descriptor.element ? toNativeType(descriptor.element) : SequelizeDataTypes.STRING
      );
    case DataType.Unknown:
    default:
      throw new Error(`Unable to convert abstract DataType "${descriptor.type}" to a Sequelize type`);
  }
}
