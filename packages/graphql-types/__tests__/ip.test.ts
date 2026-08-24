import {describe, expect, it} from "@jest/globals";
import {parseValue as parseLiteralNode} from "graphql";
import IPType from "../src/ip";

const VALID = [
  "0.0.0.0",
  "192.168.0.1",
  "255.255.255.255",
  "10.0.0.0/8",       // v4 with a CIDR prefix
  "::",
  "::1",
  "2001:db8::1",
  "2001:0db8:0000:0000:0000:ff00:0042:8329",
  "fe80::1/64",       // v6 with a CIDR prefix
  "::ffff:192.168.0.1", // v4-mapped v6
];

const INVALID = [
  "256.1.1.1",        // octet out of range
  "1.2.3",            // too few octets
  "1.2.3.4.5",        // too many
  "192.168.0.1/33",   // prefix out of range for v4
  "2001:db8::1/129",  // prefix out of range for v6
  "gggg::1",          // not hex
  "",
  "localhost",
];

describe("graphql-types - IP", () => {
  it.each(VALID)("accepts %s on every coercion path", (value) => {
    expect(IPType.serialize(value)).toBe(value);
    expect(IPType.parseValue(value)).toBe(value);
    expect(IPType.parseLiteral!(parseLiteralNode(JSON.stringify(value)), undefined)).toBe(value);
  });
  it.each(INVALID)("rejects %s", (value) => {
    expect(() => IPType.parseValue(value)).toThrow(TypeError);
    expect(() => IPType.serialize(value)).toThrow(/not a valid IP address/);
  });
  it("rejects a non-string before it ever reaches a regex", () => {
    // The regexes would happily stringify a number; the type check is what stops
    // `serialize(3232235521)` from becoming a plausible-looking address.
    expect(() => IPType.parseValue(3232235521)).toThrow(/Value is not string/);
    expect(() => IPType.parseValue(null)).toThrow(/Value is not string/);
    expect(() => IPType.parseValue({})).toThrow(/Value is not string/);
  });
  it("parseLiteral rejects every non-string literal kind", () => {
    expect(() => IPType.parseLiteral!(parseLiteralNode("123"), undefined)).toThrow(/Can only validate strings as IP addresses but got a: IntValue/);
    expect(() => IPType.parseLiteral!(parseLiteralNode("[]"), undefined)).toThrow(/ListValue/);
  });
});
