import {describe, it, expect} from "@jest/globals";

import pruneModelTypes from "../../src/graphql/utils/model-types";

/**
 * The `"[]"` convention is decoded in exactly one place, and this pins it: the
 * builder's type cache pairs each `"Name"` with a `"Name[]"` list wrapper, and
 * only the base name can ever be looked up on a schema.
 */
describe("pruneModelTypes", () => {
  const cache = {Parent: 1, "Parent[]": 2, Loner: 3, "Loner[]": 4, Child: 5, "Child[]": 6};
  const published = (name: string) => name !== "Loner";

  it("drops a list wrapper exactly when its base is dropped", () => {
    expect(pruneModelTypes(cache, published)).toEqual({
      Parent: 1, "Parent[]": 2, Child: 5, "Child[]": 6,
    });
  });

  it("preserves key order, so the recorded ledger stays stable", () => {
    expect(Object.keys(pruneModelTypes(cache, published)))
      .toEqual(["Parent", "Parent[]", "Child", "Child[]"]);
  });

  it("leaves the input untouched", () => {
    const before = {...cache};
    pruneModelTypes(cache, published);
    expect(cache).toEqual(before);
  });

  it("keeps everything when nothing is unreachable", () => {
    expect(pruneModelTypes(cache, () => true)).toEqual(cache);
  });

  it("returns an empty map when the schema publishes none of them", () => {
    expect(pruneModelTypes(cache, () => false)).toEqual({});
  });
});
