import { describe, it, expect } from "@jest/globals";
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLScalarType,
  GraphQLString,
} from "graphql";
import { coerceTransformParams } from "../src/transform-params";

const Color = new GraphQLEnumType({ name: "Color", values: { RED: { value: "r" }, BLUE: { value: "b" } } });
const Point = new GraphQLInputObjectType({
  name: "Point",
  fields: { x: { type: new GraphQLNonNull(GraphQLInt) }, y: { type: GraphQLInt, defaultValue: 0 } },
});
const Pick = new GraphQLInputObjectType({ name: "Pick", isOneOf: true, fields: { a: { type: GraphQLInt }, b: { type: GraphQLInt } } });
const Even = new GraphQLScalarType({
  name: "Even",
  parseValue(v) {
    if (typeof v !== "number" || v % 2 !== 0) {
      throw new TypeError("not even");
    }
    return v;
  },
});

const method = {
  args: {
    text: { type: GraphQLString },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    color: { type: Color },
    tags: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    at: { type: Point },
    pick: { type: Pick },
    even: { type: Even },
    flag: { type: GraphQLBoolean, defaultValue: true },
  },
};

const ok = (params: unknown) => {
  const r = coerceTransformParams(method, params);
  if (!r.ok) {
    throw new Error(r.message);
  }
  return r.value;
};
const refused = (params: unknown) => coerceTransformParams(method, params).ok === false;

describe("coerceTransformParams", () => {
  it("passes 'not asked for' through untouched", () => {
    for (const v of [undefined, null, false]) {
      expect(coerceTransformParams(method, v)).toEqual({ ok: true, value: v });
    }
  });

  it("coerces declared args, fills defaults and maps enum names to values", () => {
    expect(ok({ count: 2, color: "RED", tags: "a", at: { x: 1 }, even: 4 })).toEqual({
      count: 2, color: "r", tags: ["a"], at: { x: 1, y: 0 }, even: 4, flag: true,
    });
  });

  it("refuses unknown keys, missing required args and values of the wrong type", () => {
    expect(refused({ count: 1, extra: 1 })).toBe(true);
    expect(refused({ text: "a" })).toBe(true);
    expect(refused(true)).toBe(true);
    expect(refused({ count: "1" })).toBe(true);
    expect(refused({ count: 1.5 })).toBe(true);
    expect(refused({ count: 1, text: { $gt: "" } })).toBe(true);
    expect(refused({ count: 1, color: "GREEN" })).toBe(true);
    expect(refused({ count: 1, tags: ["a", null] })).toBe(true);
    expect(refused({ count: 1, at: { y: 1 } })).toBe(true);
    expect(refused({ count: 1, at: { x: 1, z: 1 } })).toBe(true);
    expect(refused({ count: 1, pick: { a: 1, b: 2 } })).toBe(true);
    expect(refused({ count: 1, even: 3 })).toBe(true);
    expect(refused({ count: null })).toBe(true);
    expect(refused(["count"])).toBe(true);
    expect(refused("count")).toBe(true);
  });

  it("does not read keys off the prototype", () => {
    expect(refused(JSON.parse("{\"count\":1,\"__proto__\":{\"x\":1}}"))).toBe(true);
  });

  it("takes only true (or an empty object) for a transform with no args", () => {
    expect(coerceTransformParams({}, true)).toEqual({ ok: true, value: true });
    expect(coerceTransformParams({}, {})).toEqual({ ok: true, value: true });
    expect(coerceTransformParams({}, { a: 1 }).ok).toBe(false);
    expect(coerceTransformParams({}, "x").ok).toBe(false);
  });

  it("reads true as no args for a transform whose args are all optional", () => {
    expect(coerceTransformParams({ args: { text: { type: GraphQLString } } }, true)).toEqual({ ok: true, value: {} });
  });

  it("refuses an arg declared with something that is not a GraphQL input type", () => {
    expect(coerceTransformParams({ args: { text: { type: "STRING" } } }, { text: "a" }).ok).toBe(false);
  });
});
