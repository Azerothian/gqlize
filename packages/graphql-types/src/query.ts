import {
  GraphQLString,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLInputFieldConfig,
  GraphQLInputType,
} from "graphql";
import property from "./utils/property";

// Local equivalent of graphql's internal `jsutils/ObjMap` type. graphql v17
// tightened its package `exports`, so the deep subpath is no longer importable;
// the shape is simply a string-keyed map.
type ObjMap<T> = { [key: string]: T };

// To generate an strict model for query types instead of blank json types
// this should fix apollo's variable cache issue

// const valueFuncs = ["eq", "ne", "gte", "lte", "lt", "not", "is", "like",
//   "notLike", "iLike", "notILike", "startsWith", "endsWith", "substring",
//   "regexp", "notRegexp", "iRegexp", "notIRegexp",
// ];
// const arrayFuncs = ["or", "and", "any", "all"];

// const arrayValues = ["in", "notIn", "contains", "contained",
//   "between", "notBetween", "overlap", "adjacent", "strictLeft",
//   "strictRight", "noExtendRight", "noExtendLeft",
// ];

export const defaultConfig = {
  getFieldType() {
    return GraphQLString;
  },
  valueFuncs: [
    "eq",
    "ne",
    "gte",
    "lte",
    "lt",
    "not",
    "is",
    "like",
    "notLike",
    "iLike",
    "notILike",
    "startsWith",
    "endsWith",
    "substring",
    "regexp",
    "notRegexp",
    "iRegexp",
    "notIRegexp",
  ],
  arrayFuncs: ["or", "and", "any", "all"],
  arrayValues: [
    "in",
    "notIn",
    "contains",
    "contained",
    "between",
    "notBetween",
    "overlap",
    "adjacent",
    "strictLeft",
    "strictRight",
    "noExtendRight",
    "noExtendLeft",
  ],
};

/**
 * What an adapter hands `createQueryType` to describe one model's `where` input.
 *
 * The optional members match the runtime guards below: an adapter that has no
 * isolated fields or no post-processing simply omits them.
 */
export interface QueryTypeConfig {
  /** Prefixed onto every generated type name, so it must be a valid GraphQL name. */
  modelName: string;
  /** Filterable fields, keyed by field name, mapped to the type each is compared against. */
  fields: { [fieldName: string]: GraphQLInputType };
  /** Comparison operators taking a single value of the field's own type — `eq`, `like`, ... */
  valueFuncs: string[];
  /** Comparison operators taking a list of the field's type — `in`, `between`, ... */
  arrayValues: string[];
  /** Boolean combinators taking a list of whole `where` objects — `or`, `and`. */
  arrayFuncs: string[];
  /** Operators that stand alone rather than nesting under a field, keyed by operator name. */
  isolatedFields?: { [operatorName: string]: GraphQLInputType };
  /** Last look at one field's operator map, e.g. to add a backend-specific operator. */
  processInnerFields?: (
    innerFields: ObjMap<GraphQLInputFieldConfig>,
    fieldType: GraphQLInputType,
  ) => ObjMap<GraphQLInputFieldConfig>;
  /** Last look at the whole `where` field map before the input object is built. */
  processFields?: (fields: ObjMap<GraphQLInputFieldConfig>) => ObjMap<GraphQLInputFieldConfig>;
}

export default function createQueryType(config: QueryTypeConfig) {
  const mainInputName = `GQLTQuery${config.modelName}Where`;
  const fieldInputType = new GraphQLInputObjectType({
    name: mainInputName,
    fields() {
      let fields = Object.keys(config.fields).reduce((o, fieldName) => {
        const actualFieldType = config.fields[fieldName];
        const fieldType = new GraphQLInputObjectType({
          name: `${mainInputName}${fieldName}`,
          fields() {
            let innerFields = config.valueFuncs.reduce((i, funcName) => {
              i[funcName] = {
                type: actualFieldType,
              };
              return i;
            }, {} as ObjMap<GraphQLInputFieldConfig>);
            innerFields = config.arrayValues.reduce((i, funcName) => {
              i[funcName] = {
                type: new GraphQLList(actualFieldType),
              };
              return i;
            }, innerFields);
            if (config.processInnerFields) {
              return config.processInnerFields(innerFields, actualFieldType);
            }
            return innerFields;
          },
        });
        o[fieldName] = {
          type: fieldType,
        };
        return o;
        // The accumulator is the field-config map the thunk must return: the two
        // passes below add a list of whole `where` objects (`arrayFuncs`) and any
        // isolated operators, so it is never uniformly "object type per field".
      }, {} as ObjMap<GraphQLInputFieldConfig>);
      fields = config.arrayFuncs.reduce((i, funcName) => {
        i[funcName] = {
          type: new GraphQLList(fieldInputType),
        };
        return i;
      }, fields);
      const {isolatedFields} = config;
      if (isolatedFields) {
        fields = Object.keys(isolatedFields).reduce((o, fieldName) => {
          o[fieldName] = {
            type: isolatedFields[fieldName],
          };
          return o;
        }, fields);
      }
      if (config.processFields) {
        return config.processFields(fields);
      }
      return fields;
    },
  });
  return fieldInputType;
}
