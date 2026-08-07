import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLNamedType,
} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {decodeTypeRef, encodeTypeRef} from "../../src/graphql/snapshot/type-ref";

const Obj = new GraphQLObjectType({name: "Obj", fields: {a: {type: GraphQLString}}});
const Inp = new GraphQLInputObjectType({name: "Inp", fields: {a: {type: GraphQLString}}});
const Enu = new GraphQLEnumType({name: "Enu", values: {A: {value: "A"}}});

const lookup = (name: string): GraphQLNamedType | undefined =>
  ({Obj, Inp, Enu, String: GraphQLString} as any)[name];

describe("type-ref", () => {
  it("round-trips every wrapper nesting", () => {
    const cases = [
      Obj,
      new GraphQLNonNull(Obj),
      new GraphQLList(Obj),
      new GraphQLNonNull(new GraphQLList(Obj)),
      new GraphQLList(new GraphQLNonNull(Obj)),
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Obj))),
      new GraphQLList(new GraphQLList(new GraphQLNonNull(Obj))),
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLList(Enu)))),
      new GraphQLNonNull(Inp),
      GraphQLString,
    ];
    for (const type of cases) {
      const ref = encodeTypeRef(type as any);
      const decoded = decodeTypeRef(ref, lookup);
      // structural equality via graphql's own printer, and identity at the leaf
      expect(String(decoded)).toEqual(ref);
      expect(decoded).toEqual(type);
    }
  });

  it("produces the SDL spelling", () => {
    expect(encodeTypeRef(new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Obj))))).toEqual("[Obj!]!");
  });

  it("throws with the coordinate on an unknown named type", () => {
    expect(() => decodeTypeRef("[Missing!]!", lookup, "Task.items")).toThrow(
      /unknown type "Missing" referenced by "\[Missing!\]!" at Task\.items/,
    );
  });

  it("throws on a malformed reference", () => {
    expect(() => decodeTypeRef("[Obj", lookup)).toThrow(/could not be parsed|could not parse type reference/);
  });
});
