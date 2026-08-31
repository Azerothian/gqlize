import { describe, expect, it } from "@jest/globals";
import { GraphQLEnumType } from "graphql";
import { createEnumType, enumTypeName, sanitizeEnumValue } from "../src/enum-type";

// GraphQL enum value names must match this. A member that does not is not a
// stylistic problem — graphql rejects it outright, which is what made this
// shared rather than per-adapter.
const GRAPHQL_NAME = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

describe("sanitizeEnumValue", () => {
  it.each([
    ["in-progress", "inProgress"],
    ["in progress", "inProgress"],
    ["2xl", "_2xl"],
    ["already_fine", "already_fine"],
    ["  padded  ", "padded"],
    ["a/b", "aB"],
    ["¼", "frac14"],
  ])("%s -> %s", (input, expected) => {
    expect(sanitizeEnumValue(input)).toBe(expected);
    expect(sanitizeEnumValue(input)).toMatch(GRAPHQL_NAME);
  });
});

describe("enumTypeName", () => {
  it("capitalises both halves, so the two adapters agree", () => {
    // The valkey adapter used to omit `capitalize` and produce `TaskstatusEnum`
    // for the same model the sequelize adapter called `TaskStatusEnum`.
    expect(enumTypeName("Task", "status")).toBe("TaskStatusEnum");
    expect(enumTypeName("task", "status")).toBe("TaskStatusEnum");
  });

  it("tolerates a missing model or field name", () => {
    expect(enumTypeName(undefined, undefined)).toBe("Enum");
  });
});

describe("createEnumType", () => {
  it("builds legal names for members that are not legal names", () => {
    const type = createEnumType("Task", "status", ["in-progress", "2xl", "done"]);
    expect(type.name).toBe("TaskStatusEnum");
    for (const value of type.getValues()) {
      expect(value.name).toMatch(GRAPHQL_NAME);
    }
    expect(type.getValues().map((v) => v.name)).toEqual(["inProgress", "_2xl", "done"]);
  });

  it("keeps the authored member as the resolved value", () => {
    // Only the schema-facing name is rewritten; what reaches the database must
    // still be exactly what the definition declared.
    const type = createEnumType("Task", "status", ["in-progress"]);
    expect(type.getValue("inProgress")?.value).toBe("in-progress");
  });

  it("reports members that collide once sanitized rather than silently merging", () => {
    // Two members differing only in punctuation would otherwise become one
    // value, leaving the loser unqueryable with no indication why.
    expect(() => createEnumType("Task", "status", ["in-progress", "in progress"]))
      .toThrow(/both sanitize to "inProgress"/);
  });

  it("does not treat a repeated identical member as a collision", () => {
    expect(() => createEnumType("Task", "status", ["done", "done"])).not.toThrow();
  });

  it("pins where graphql rejects an unsanitized member", () => {
    // Not a test of our code — a test of the assumption this module exists for,
    // and of *where* the failure lands. graphql builds enum values lazily, so
    // the constructor succeeds and the throw arrives later, when something first
    // materialises them. That is why the old per-adapter bug surfaced far from
    // the definition that caused it.
    const raw = new GraphQLEnumType({ name: "Raw", values: { "in-progress": { value: "x" } } });
    expect(() => raw.getValues()).toThrow(/Names must only contain/);
  });
});
