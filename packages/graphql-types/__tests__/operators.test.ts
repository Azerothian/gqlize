import {describe, expect, it} from "@jest/globals";
import {
  CORE_ARRAY_FUNCS,
  CORE_ARRAY_VALUES,
  CORE_VALUE_FUNCS,
  REGEX_VALUE_FUNCS,
  SQL_ARRAY_FUNCS,
  SQL_ARRAY_VALUES,
} from "../src/operators";

// These lists become GraphQL input fields in iteration order, so the printed SDL
// — and the golden snapshots pinning it — change if one is reordered. Spelling
// them out here means a reorder fails with a readable diff in the package that
// owns them, rather than as a snapshot churn two packages downstream.

describe("operator vocabularies", () => {
  it("pins the core value operators and their order", () => {
    expect(CORE_VALUE_FUNCS).toEqual([
      "eq", "ne", "gte", "lte", "lt", "not", "is",
      "like", "notLike", "iLike", "notILike",
      "startsWith", "endsWith", "substring",
    ]);
  });

  it("keeps the regex operators out of the core set", () => {
    // Opt-in only: on dialects that evaluate client-supplied patterns these are
    // a ReDoS vector, so an adapter has to ask for them by name.
    expect(REGEX_VALUE_FUNCS).toEqual(["regexp", "notRegexp", "iRegexp", "notIRegexp"]);
    for (const func of REGEX_VALUE_FUNCS) {
      expect(CORE_VALUE_FUNCS).not.toContain(func);
    }
  });

  it("pins the boolean combinators, with SQL's quantified forms appended", () => {
    expect(CORE_ARRAY_FUNCS).toEqual(["or", "and"]);
    expect(SQL_ARRAY_FUNCS).toEqual(["or", "and", "any", "all"]);
  });

  it("pins the list operators, with SQL's extras interleaved rather than appended", () => {
    expect(CORE_ARRAY_VALUES).toEqual(["in", "notIn", "between", "notBetween"]);
    expect(SQL_ARRAY_VALUES).toEqual([
      "in", "notIn", "contains", "contained", "between", "notBetween",
      "overlap", "adjacent", "strictLeft", "strictRight", "noExtendRight", "noExtendLeft",
    ]);
    // The reason SQL_ARRAY_VALUES cannot be composed from CORE_ARRAY_VALUES:
    // `contains`/`contained` sit between `notIn` and `between`.
    expect(SQL_ARRAY_VALUES.slice(0, 4)).not.toEqual(CORE_ARRAY_VALUES);
  });
});
