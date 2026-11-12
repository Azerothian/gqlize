// The operator half of `assertFilterAllowed`: a field's filter may only hold
// filter operators, because the adapter honours any ORM operator name it is
// handed (`{name: {col: "secret"}}` reads the `secret` column).
import { describe, it, expect } from "@jest/globals";
import { assertFilterAllowed, type Fail } from "../src/guards";
import { FILTER_REGEX_OPERATORS, regexOperatorsEnabled } from "../src/filter-operators";

const fail: Fail = (_kind, message) => {
  throw new Error(message);
};

const check = (where: unknown, options?: { regexOperators?: boolean }, definition?: { whereOperators?: object }) =>
  () => assertFilterAllowed(undefined, "M", where, fail, definition, options);

describe("assertFilterAllowed: operators", () => {
  it("accepts every filter operator, bare values, and values that are objects", () => {
    expect(check({ name: "x", rank: 1 })).not.toThrow();
    expect(check({ name: { eq: "x", ne: "y", like: "%x", startsWith: "a" } })).not.toThrow();
    expect(check({ rank: { in: [1, 2], between: [1, 9], gte: 1 } })).not.toThrow();
    expect(check({ or: [{ name: { iLike: "x" } }], and: [{ rank: { not: 3 } }], not: { name: { is: null } } })).not.toThrow();
    expect(check({ createdAt: { gt: new Date() } })).not.toThrow();
  });

  it("refuses an ORM operator in a field, at any depth", () => {
    for (const where of [
      { name: { col: "secret" } },
      { name: { eq: "x", col: "secret" } },
      { name: { not: { col: "secret" } } },
      { name: { in: [{ col: "secret" }] } },
      { or: [{ name: { col: "secret" } }] },
      { and: [{ or: [{ name: { raw: "1=1" } }] }] },
      { name: { or: ["a", "b"] } },
      { name: { values: [1] } },
      { name: { placeholder: true } },
      { name: { any: [1] } },
      { name: { match: "x" } },
      // As a request body parses it: JSON.parse makes `__proto__` an own key.
      JSON.parse('{"name":{"__proto__":{"col":"secret"}}}') as unknown,
    ]) {
      expect(check(where)).toThrow(/operator/);
    }
  });

  it("refuses the regex operators unless the adapter offers them", () => {
    for (const op of FILTER_REGEX_OPERATORS) {
      expect(check({ name: { [op]: "^a" } })).toThrow(/operator/);
      expect(check({ name: { [op]: "^a" } }, { regexOperators: true })).not.toThrow();
    }
    expect(regexOperatorsEnabled({ options: { enableRegexpOperators: true } })).toBe(true);
    expect(regexOperatorsEnabled({ options: {} })).toBe(false);
    expect(regexOperatorsEnabled(undefined)).toBe(false);
  });

  it("leaves a definition's own where operators to their handler", () => {
    const definition = { whereOperators: { nearby: () => ({}) } };
    expect(check({ nearby: { lat: 1, lng: 2 } }, undefined, definition)).not.toThrow();
    // Only the definition's own keys: a field of that name elsewhere is still checked.
    expect(check({ nearby: { lat: 1 } })).toThrow(/operator/);
  });
});
