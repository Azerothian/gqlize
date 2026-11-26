// Tests that relationship quantifier keys are rejected in client-supplied
// where clauses. Phase 1 of the row-security RFC: quantifiers are engine-only
// (scope, global filters, direct callers), never client-facing.

import { describe, it, expect } from "@jest/globals";
import { assertFilterAllowed } from "../src/guards";

const fail = (kind: string, message: string) => {
  throw new Error(`${kind}: ${message}`);
};

describe("utilize - guards: quantifier rejection in client where", () => {
  it("rejects a `some` quantifier on a client-supplied filter", () => {
    expect(() =>
      assertFilterAllowed(undefined, "User", { memberships: { some: { role: { eq: "manager" } } } }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("rejects a `none` quantifier", () => {
    expect(() =>
      assertFilterAllowed(undefined, "User", { memberships: { none: {} } }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("rejects an `every` quantifier", () => {
    expect(() =>
      assertFilterAllowed(undefined, "User", { tags: { every: { active: { eq: true } } } }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("rejects an `is` quantifier", () => {
    expect(() =>
      assertFilterAllowed(undefined, "Task", { owner: { is: { name: { eq: "alice" } } } }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("rejects an `isNot` quantifier", () => {
    expect(() =>
      assertFilterAllowed(undefined, "Task", { owner: { isNot: { active: { eq: false } } } }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("rejects quantifiers nested in logical operators", () => {
    expect(() =>
      assertFilterAllowed(undefined, "User", {
        or: [
          { name: { eq: "alice" } },
          { memberships: { some: {} } },
        ],
      }, fail),
    ).toThrow("Relationship quantifier filters are not allowed");
  });

  it("allows a normal field filter that happens to have a single key", () => {
    // A field like { status: { eq: "active" } } should not be confused with
    // a quantifier — `eq` is not in ALL_QUANTIFIERS.
    expect(() =>
      assertFilterAllowed(undefined, "Task", { status: { eq: "active" } }, fail, undefined, {}),
    ).not.toThrow();
  });

  it("allows a normal field with an `in` operator", () => {
    expect(() =>
      assertFilterAllowed(undefined, "Task", { id: { in: [1, 2, 3] } }, fail, undefined, {}),
    ).not.toThrow();
  });
});
