import {describe, expect, it} from "@jest/globals";
import {
  GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLString, printType,
} from "graphql";
import createQueryType from "../src/query";

const base = {
  modelName: "Task",
  fields: {id: GraphQLInt, name: GraphQLString},
  valueFuncs: ["eq", "like"],
  arrayValues: ["in"],
  arrayFuncs: ["or", "and"],
};

const fieldsOf = (type: GraphQLInputObjectType) => type.getFields();

describe("graphql-types - createQueryType", () => {
  it("names the where type and one nested type per field", () => {
    const where = createQueryType(base);
    expect(where.name).toBe("GQLTQueryTaskWhere");
    const inner = fieldsOf(where).id.type as GraphQLInputObjectType;
    expect(inner.name).toBe("GQLTQueryTaskWhereid");
  });
  it("gives each field the value operators at its own type and the array ones as lists", () => {
    const inner = fieldsOf(createQueryType(base)).name.type as GraphQLInputObjectType;
    expect(printType(inner)).toBe([
      "input GQLTQueryTaskWherename {",
      "  eq: String",
      "  like: String",
      "  in: [String]",
      "}",
    ].join("\n"));
  });
  it("makes the boolean combinators lists of the whole where type", () => {
    const where = createQueryType(base);
    const or = fieldsOf(where).or.type as GraphQLList<GraphQLInputObjectType>;
    // Self-referential, which is why the field map is a thunk.
    expect(or.ofType).toBe(where);
    expect(fieldsOf(where).and.type).toBeInstanceOf(GraphQLList);
  });
  it("adds isolatedFields alongside the per-field ones rather than under them", () => {
    const where = createQueryType({...base, isolatedFields: {deleted: GraphQLBoolean}});
    expect(fieldsOf(where).deleted.type).toBe(GraphQLBoolean);
  });
  it("gives processInnerFields the last look at one field's operators", () => {
    const where = createQueryType({
      ...base,
      processInnerFields: (innerFields, fieldType) => ({...innerFields, custom: {type: fieldType}}),
    });
    const inner = fieldsOf(where).id.type as GraphQLInputObjectType;
    expect(fieldsOf(inner).custom.type).toBe(GraphQLInt);
    expect(fieldsOf(inner).eq.type).toBe(GraphQLInt);
  });
  it("gives processFields the last look at the whole where map", () => {
    const where = createQueryType({
      ...base,
      processFields: (fields) => ({...fields, extra: {type: GraphQLString}}),
    });
    expect(fieldsOf(where).extra.type).toBe(GraphQLString);
    expect(Object.keys(fieldsOf(where))).toEqual(["id", "name", "or", "and", "extra"]);
  });
});
