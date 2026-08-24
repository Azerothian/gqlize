import {describe, expect, it} from "@jest/globals";
import {Kind, parseValue as parseLiteralNode} from "graphql";
import BigIntType from "../src/bigint";

// 2^53 - 1. Anything past it is exactly where a Number-based implementation
// starts silently rounding, which is the whole reason this scalar exists.
const MAX_SAFE = "9007199254740991";
const PAST_SAFE = "9007199254740993";

describe("graphql-types - GQLTBigInt", () => {
  it("serializes to a decimal string, not a Number", () => {
    expect(BigIntType.serialize(123n)).toBe("123");
    expect(BigIntType.serialize(PAST_SAFE)).toBe(PAST_SAFE);
  });
  it("parseValue keeps precision past Number.MAX_SAFE_INTEGER", () => {
    expect(BigIntType.parseValue(PAST_SAFE)).toBe(9007199254740993n);
    // The failure this pins: `Number("9007199254740993")` is 9007199254740992.
    expect(String(BigIntType.parseValue(PAST_SAFE))).not.toBe(String(Number(PAST_SAFE)));
    expect(BigIntType.parseValue(MAX_SAFE)).toBe(9007199254740991n);
  });
  it("parseValue accepts the other things BigInt() accepts", () => {
    expect(BigIntType.parseValue(42)).toBe(42n);
    expect(BigIntType.parseValue(true)).toBe(1n);
    expect(BigIntType.parseValue(7n)).toBe(7n);
  });
  it("parseValue surfaces BigInt()'s own error for a value it cannot convert", () => {
    expect(() => BigIntType.parseValue(1.5)).toThrow(RangeError);
    expect(() => BigIntType.parseValue("nope")).toThrow(SyntaxError);
  });
  it("parseLiteral takes a string literal and keeps its precision", () => {
    expect(BigIntType.parseLiteral(parseLiteralNode(`"${PAST_SAFE}"`), undefined)).toBe(9007199254740993n);
  });
  it("parseLiteral rejects every other literal kind", () => {
    // An int literal is the tempting one: graphql would have already coerced it
    // through a Number by the time it got here, so it is refused outright.
    const int = parseLiteralNode("123");
    expect(int.kind).toBe(Kind.INT);
    expect(() => BigIntType.parseLiteral(int, undefined)).toThrow(/Can only validate strings as big integers but got a: IntValue/);
    expect(() => BigIntType.parseLiteral(parseLiteralNode("true"), undefined)).toThrow(/BooleanValue/);
  });
  it("patches BigInt.prototype.toJSON so a bigint survives JSON.stringify", () => {
    // Importing this module mutates a global — the one `@ts-ignore` in the repo.
    // Without it `JSON.stringify` throws "Do not know how to serialize a BigInt".
    expect(JSON.stringify({total: 9007199254740993n})).toBe(`{"total":"9007199254740993"}`);
  });
});
