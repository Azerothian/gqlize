import { describe, it, expect } from "@jest/globals";
import { toIncludePlan } from "../src/utils/include-plan";
import type { IncludeMap } from "../src/types/index";

describe("toIncludePlan (#68)", () => {
  it("leaves an absent plan absent", () => {
    expect(toIncludePlan(undefined)).toBeUndefined();
    expect(toIncludePlan(null)).toBeUndefined();
  });

  it("turns one object into a list of one", () => {
    expect(toIncludePlan({ posts: { required: true } })).toEqual([{ posts: { required: true } }]);
  });

  it("normalises nested includes at every depth", () => {
    expect(toIncludePlan({ posts: { include: { comments: { include: { author: {} } } } } })).toEqual([
      { posts: { include: [{ comments: { include: [{ author: {} }] } }] } },
    ]);
  });

  it("returns a plan already in shape as the same object, and never writes the input", () => {
    const plan = [{ posts: { target: "Post", associationType: "hasMany", include: [{ author: {} }] } }] as unknown as IncludeMap[];
    expect(toIncludePlan(plan)).toBe(plan);
    const mixed = [{ posts: { include: { author: {} } } }];
    const before = JSON.stringify(mixed);
    const out = toIncludePlan(mixed);
    expect(out).not.toBe(mixed);
    expect(JSON.stringify(mixed)).toBe(before);
    expect(out).toEqual([{ posts: { include: [{ author: {} }] } }]);
  });
});
