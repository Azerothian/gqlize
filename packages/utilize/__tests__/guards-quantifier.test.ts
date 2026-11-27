// Tests that relationship quantifier keys are rejected in client-supplied
// where clauses, while legitimate scalar operators (including `is`) pass.
// Phase 1 of the row-security RFC.

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

  it("rejects an `is` quantifier (object inner value)", () => {
    // `is` with an object inner is a quantifier, not the scalar `is` operator.
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
});

describe("utilize - guards: legitimate scalar `is` filters pass", () => {
  it("allows { deletedAt: { is: null } }", () => {
    // The scalar `is` operator takes a primitive (null, boolean, etc.),
    // not an object, so parseQuantifier returns undefined.
    expect(() =>
      assertFilterAllowed(undefined, "Task", { deletedAt: { is: null } }, fail, undefined, {}),
    ).not.toThrow();
  });

  it("allows { active: { is: true } }", () => {
    expect(() =>
      assertFilterAllowed(undefined, "Task", { active: { is: true } }, fail, undefined, {}),
    ).not.toThrow();
  });

  it("allows { status: { is: 'draft' } }", () => {
    expect(() =>
      assertFilterAllowed(undefined, "Task", { status: { is: "draft" } }, fail, undefined, {}),
    ).not.toThrow();
  });

  it("allows a normal field filter with eq", () => {
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
