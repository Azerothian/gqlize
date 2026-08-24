import {describe, expect, it} from "@jest/globals";
import {ValueNode, parseValue as parseLiteralNode} from "graphql";
import JSONType from "../src/json";

const literal = (source: string, variables?: {[name: string]: unknown}) =>
  JSONType.parseLiteral(parseLiteralNode(source), variables);

describe("graphql-types - GQLTJson", () => {
  it("serializes as the identity — the value is already JSON", () => {
    const value = {a: [1, {b: null}]};
    expect(JSONType.serialize(value)).toBe(value);
  });
  it("parseValue parses a JSON string and passes anything else through", () => {
    expect(JSONType.parseValue(`{"a":1}`)).toEqual({a: 1});
    const already = {a: 1};
    expect(JSONType.parseValue(already)).toBe(already);
    expect(JSONType.parseValue(7)).toBe(7);
  });
  it("walks a nested literal down to scalars of the right runtime type", () => {
    expect(literal(`{a: 1, b: 1.5, c: "s", d: true, e: null, f: ENUM_VAL}`)).toEqual({
      a: 1, b: 1.5, c: "s", d: true, e: null, f: "ENUM_VAL",
    });
    // Not just deep-equal: an INT must not arrive as a string.
    const parsed = literal(`{a: 1, b: 1.5}`) as {a: unknown; b: unknown};
    expect(typeof parsed.a).toBe("number");
    expect(typeof parsed.b).toBe("number");
  });
  it("walks lists and objects nested in each other", () => {
    expect(literal(`{rows: [{id: 1, tags: ["a", "b"]}, {id: 2, tags: []}]}`)).toEqual({
      rows: [{id: 1, tags: ["a", "b"]}, {id: 2, tags: []}],
    });
    expect(literal(`[[1, 2], [3]]`)).toEqual([[1, 2], [3]]);
  });
  it("resolves a variable nested inside a literal", () => {
    // graphql-js hands the operation's variables to parseLiteral as its second
    // argument; without this a `{a: $v}` literal would silently be `{a: undefined}`.
    expect(literal(`{a: $v, b: [$v, 2]}`, {v: 7})).toEqual({a: 7, b: [7, 2]});
    expect(literal(`{a: $v}`, {v: null})).toEqual({a: null});
  });
  it("yields undefined for a variable when no variables were supplied", () => {
    expect(literal(`{a: $v}`)).toEqual({a: undefined});
  });
  it("returns null for a node kind it has no handler for", () => {
    // Every kind a real ValueNode can be is handled, so this fallback is only
    // reachable with a synthetic node — it exists so a future graphql adding a
    // value kind degrades to null instead of throwing.
    expect(JSONType.parseLiteral({kind: "FutureValue"} as unknown as ValueNode, undefined)).toBeNull();
  });
});
