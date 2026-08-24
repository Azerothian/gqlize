import {describe, expect, it} from "@jest/globals";
import {parseValue as parseLiteralNode} from "graphql";
import DateType from "../src/date";

const ISO = "2024-03-05T06:07:08.900Z";

describe("graphql-types - GQLTDate", () => {
  it("round-trips an ISO string through parseValue and serialize", () => {
    const parsed = DateType.parseValue(ISO) as Date;
    expect(parsed).toBeInstanceOf(Date);
    expect(DateType.serialize(parsed)).toBe(ISO);
  });
  it("serializes only Dates, passing anything else through untouched", () => {
    // The adapters hand back whatever the driver produced: sqlite gives a string
    // where postgres gives a Date, and both have to print the same field.
    expect(DateType.serialize(ISO)).toBe(ISO);
    expect(DateType.serialize(null)).toBeNull();
    expect(DateType.serialize(undefined)).toBeNull();
  });
  it("treats an absent value as null rather than as the epoch", () => {
    expect(DateType.parseValue(null)).toBeNull();
    expect(DateType.parseValue("")).toBeNull();
    // `new Date(0)` is what a naive implementation would return for these.
    expect(DateType.parseValue(0)).toBeNull();
  });
  it("parseValue accepts a millisecond timestamp", () => {
    const ms = Date.parse(ISO);
    expect((DateType.parseValue(ms) as Date).toISOString()).toBe(ISO);
  });
  it("parseLiteral reads a string literal", () => {
    expect((DateType.parseLiteral(parseLiteralNode(`"${ISO}"`), undefined) as Date).toISOString()).toBe(ISO);
  });
  it("parseLiteral yields an Invalid Date for a literal kind carrying no value", () => {
    // Lists and objects have no `value` member; the result is a Date that fails
    // every comparison rather than a throw, which is what it did before the
    // parameter was typed.
    const invalid = DateType.parseLiteral(parseLiteralNode("[1, 2]"), undefined) as Date;
    expect(invalid).toBeInstanceOf(Date);
    expect(Number.isNaN(invalid.getTime())).toBe(true);
  });
});
