import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  GraphQLEnumType,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import jsonType from "@azerothian/graphql-types/json";
import dateType from "@azerothian/graphql-types/date";
import uploadType from "@azerothian/graphql-types/upload";
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
      return new GraphQLList(typeMapper(desc.element as DataTypeDescriptor, modelName, fieldName));
    case DataType.Enum:
      return new GraphQLEnumType({
        name: `${modelName || ""}${fieldName || ""}Enum`,
        values: (desc.values || []).reduce((o: {[name: string]: {value: string}}, v: string) => {
          o[v] = { value: v };
          return o;
        }, {}),
      });
    default:
      // String / UUID / Decimal / BigInt / Unknown → String
      return GraphQLString;
  }
}
