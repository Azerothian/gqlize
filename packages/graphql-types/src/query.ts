import {
  GraphQLScalarType,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLString,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLInputFieldConfig,
  Kind,
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

interface QueryTypeConfig {
  modelName: any;
  fields: { [x: string]: any };
  valueFuncs: any[];
  arrayValues: any[];
  processInnerFields: (arg0: any, arg1: any) => ObjMap<GraphQLInputFieldConfig>;
  arrayFuncs: any[];
  isolatedFields: { [x: string]: any };
  processFields: (arg0: {}) => ObjMap<GraphQLInputFieldConfig>;
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
            }, {});
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
      }, {} as {[key: string]: {type: GraphQLInputObjectType}});
      fields = config.arrayFuncs.reduce((i, funcName) => {
        i[funcName] = {
          type: new GraphQLList(fieldInputType),
        };
        return i;
      }, fields);
      if (config.isolatedFields) {
        fields = Object.keys(config.isolatedFields).reduce((o, fieldName) => {
          o[fieldName] = {
            type: config.isolatedFields[fieldName],
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
