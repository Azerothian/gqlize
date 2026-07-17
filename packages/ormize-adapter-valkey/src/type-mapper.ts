import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  GraphQLEnumType,
} from "graphql";
import jsonType from "@azerothian/graphql-types/json";
import dateType from "@azerothian/graphql-types/date";
import uploadType from "@azerothian/graphql-types/upload";
import { DataType, DataTypeDescriptor } from "@azerothian/utilize/types/data-type";

/** Map an abstract `DataTypeDescriptor` to a GraphQL output/scalar type. */
export default function typeMapper(desc: DataTypeDescriptor, modelName?: string, fieldName?: string): any {
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
        values: (desc.values || []).reduce((o: any, v: string) => {
          o[v] = { value: v };
          return o;
        }, {}),
      });
    default:
      // String / UUID / Decimal / BigInt / Unknown → String
      return GraphQLString;
  }
}
