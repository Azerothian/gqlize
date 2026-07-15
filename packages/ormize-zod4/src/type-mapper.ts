import { z } from "zod";
import { DataType, DataTypeDescriptor } from "@azerothian/ormize";

/**
 * Map an abstract ormize `DataTypeDescriptor` (obtained via `orm.mapDataType`)
 * to a base Zod schema. Fully adapter-agnostic — no `sequelize` knowledge here.
 */
export function descriptorToZod(descriptor: DataTypeDescriptor): z.ZodTypeAny {
  switch (descriptor.type) {
    case DataType.Boolean:
      return z.boolean();
    case DataType.Int:
      return z.number().int();
    case DataType.Float:
      return z.number();
    case DataType.String:
      return z.string();
    case DataType.BigInt:
    case DataType.Decimal:
      // Represented as strings to preserve precision (parity with the GraphQL mapper).
      return z.string();
    case DataType.UUID:
      return z.uuid();
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      return z.date();
    case DataType.Enum:
      return descriptor.values && descriptor.values.length > 0
        ? z.enum(descriptor.values as [string, ...string[]])
        : z.string();
    case DataType.Array:
      return z.array(descriptor.element ? descriptorToZod(descriptor.element) : z.unknown());
    case DataType.JSON:
      return z.unknown();
    case DataType.Blob:
      return z.union([z.instanceof(Uint8Array), z.string()]);
    case DataType.Unknown:
    default:
      return z.unknown();
  }
}
