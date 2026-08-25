// For a Valkey/JSON backend there is no separate native type system — the
// abstract `DataTypeDescriptor` IS the stored type. `mapDataType`/`toNativeType`
// are therefore (near-)identity; `toDescriptor` adds authoring ergonomics so a
// definition can use either a `DataTypes.*` token or a plain JS constructor.

import {
  DataTypeDescriptor,
  DataTypes,
  isOrmizeDataType,
} from "@azerothian/utilize/types/data-type";
import type { DefinitionField, DefinitionFields, NativeDataType } from "@azerothian/utilize/types/index";

/** Normalize an authored field type (token or JS constructor) to a descriptor. */
export function toDescriptor(t: unknown): DataTypeDescriptor {
  if (isOrmizeDataType(t)) {
    return t;
  }
  switch (t) {
    case String:
      return DataTypes.String;
    case Number:
      return DataTypes.Int;
    case Boolean:
      return DataTypes.Boolean;
    case Date:
      return DataTypes.Date;
    case BigInt:
      return DataTypes.BigInt;
    case Array:
      return DataTypes.Array(DataTypes.Unknown);
    case Object:
      return DataTypes.JSON;
    default:
      return DataTypes.Unknown;
  }
}

/** Read path: classify a stored native type — already a descriptor for Valkey. */
export function mapDataType(nativeType: NativeDataType): DataTypeDescriptor {
  return toDescriptor(nativeType);
}

/** Write path: the descriptor is the native type. */
export function toNativeType(descriptor: DataTypeDescriptor): NativeDataType {
  return descriptor;
}

/** Normalize a whole `define` block's field types to descriptors. */
export function resolveAttributeTypes(define: DefinitionFields): { [k: string]: DefinitionField & { type: DataTypeDescriptor } } {
  const out: { [k: string]: DefinitionField & { type: DataTypeDescriptor } } = {};
  for (const key of Object.keys(define || {})) {
    const field = define[key];
    // `DefinitionFields` is the declared shape, but a `define` block also admits
    // shorthand entries that are bare type tokens (`field: String`) rather than
    // field-descriptor objects — so `field` here is only field-shaped once this
    // check confirms it.
    if (field && typeof field === "object" && !isOrmizeDataType(field)) {
      out[key] = { ...field, type: toDescriptor(field.type) };
    } else {
      // Shorthand `field: DataTypes.String` / `field: String`.
      out[key] = { type: toDescriptor(field) };
    }
  }
  return out;
}

