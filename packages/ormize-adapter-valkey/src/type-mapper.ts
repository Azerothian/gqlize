import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import jsonType from "@azerothian/graphql-types/json";
import dateType from "@azerothian/graphql-types/date";
import uploadType from "@azerothian/graphql-types/upload";
import { createEnumType } from "@azerothian/graphql-types/enum-type";
import { DataType, DataTypeDescriptor } from "@azerothian/utilize/types/data-type";
import type { NativeDataType } from "@azerothian/utilize/types/index";

/**
 * Map a field's type to a GraphQL type valid in both variances — the same mapper
 * builds output fields and `where` input fields alike.
 *
 * The parameter is the contract's opaque {@link NativeDataType}, not
 * `DataTypeDescriptor`, because that is what a caller holds: `getFields()` hands
 * back field types the contract leaves open. For this adapter the native type
 * *is* a descriptor — Valkey has no type system of its own — so the narrowing
 * happens here, once, at the boundary.
 */
export default function typeMapper(
  nativeType: NativeDataType, modelName?: string, fieldName?: string,
): GraphQLInputType & GraphQLOutputType {
  const desc = nativeType as DataTypeDescriptor | undefined;
  switch (desc?.type) {
    case DataType.Int:
      return GraphQLInt;
    case DataType.Float:
      return GraphQLFloat;
    case DataType.Boolean:
      return GraphQLBoolean;
    case DataType.Date:
    case DataType.DateOnly:
    case DataType.Time:
      return dateType;
    case DataType.JSON:
      return jsonType;
    case DataType.Blob:
      return uploadType;
    case DataType.Array:
      return new GraphQLList(typeMapper(desc.element, modelName, fieldName));
    case DataType.Enum:
      // Shared with the sequelize adapter — see
      // `@azerothian/graphql-types/enum-type`. This used to name the type
      // without capitalising and use each member verbatim as its GraphQL value
      // name, so the same model produced a different type name on each backend
      // and any member with a space, hyphen or leading digit threw here.
      return createEnumType(modelName, fieldName, desc.values || []);
    default:
      // String / UUID / Decimal / BigInt / Unknown → String
      return GraphQLString;
  }
}
