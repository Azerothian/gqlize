import { describe, it, expect } from "@jest/globals";
import waterfall, { waterfallSync } from "../src/utils/waterfall";

/**
 * `@azerothian/utilize/utils/waterfall` is a published subpath with 46 call
 * sites across three other packages and, until this file, no tests at all —
 * so a change to its signature had nothing but `tsc` behind it. These cover the
 * behaviours those call sites actually depend on rather than the happy path
 * alone: the ordering guarantee, the accumulator threading, the scalar
 * coercion, and what an absent seed does.
 */
describe("utilize - waterfall", () => {
  it("runs one element at a time, in order, never overlapping", async() => {
    const order: string[] = [];
    let running = 0;
    await waterfall([1, 2, 3], async(val: number) => {
      running += 1;
      expect(running).toBe(1);
      order.push(`start:${val}`);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      order.push(`end:${val}`);
      running -= 1;
    });
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
  });

  it("threads each call's result into the next and resolves to the last", async() => {
    const seen: number[] = [];
    const total = await waterfall([1, 2, 3], (val: number, acc: number) => {
      seen.push(acc);
      return acc + val;
    }, 0);
    expect(seen).toEqual([0, 1, 3]);
    expect(total).toBe(6);
  });

  it("awaits a step that returns a promise before starting the next", async() => {
    const total = await waterfall([1, 2], async(val: number, acc: number) => {
      await Promise.resolve();
      return acc + val;
    }, 10);
    expect(total).toBe(13);
  });

  it("wraps a non-array argument into a single-element run", async() => {
    // `gqlize/src/graphql/resolvers/mutation.ts` and the relationship-mutation
    // helpers pass a value-or-list straight through and rely on this.
    const seen: string[] = [];
    await waterfall("only", (val: string) => { seen.push(val); });
    expect(seen).toEqual(["only"]);
  });

  it("resolves to the seed for an empty array, without calling the step", async() => {
    let calls = 0;
    const result = await waterfall([] as string[], (_val: string, acc: string) => {
      calls += 1;
      return acc;
    }, "seed");
    expect(calls).toBe(0);
    expect(result).toBe("seed");
  });

  it("resolves to undefined when no seed is given", async() => {
    // 26 of the call sites pass no accumulator at all and use this purely as
    // "do these in sequence", so an absent `start` has to stay legal.
    const seen: number[] = [];
    const result = await waterfall([1, 2], (val: number) => { seen.push(val); });
    expect(seen).toEqual([1, 2]);
    expect(result).toBeUndefined();
  });

  it("defaults to an empty run when called with no arguments", async() => {
    await expect(waterfall()).resolves.toBeUndefined();
  });

  it("rejects on the first throwing step and stops there", async() => {
    const seen: number[] = [];
    await expect(waterfall([1, 2, 3], (val: number) => {
      seen.push(val);
      if (val === 2) {
        throw new Error("boom");
      }
    })).rejects.toThrow("boom");
    expect(seen).toEqual([1, 2]);
  });
});

describe("utilize - waterfallSync", () => {
  it("threads the accumulator and returns the last result", () => {
    const seen: number[] = [];
    const total = waterfallSync([1, 2, 3], (val: number, acc: number) => {
      seen.push(acc);
      return acc + val;
    }, 0);
    expect(seen).toEqual([0, 1, 3]);
    expect(total).toBe(6);
  });

  it("wraps a non-array argument, and returns the seed for an empty array", () => {
    const seen: string[] = [];
    waterfallSync("only", (val: string) => { seen.push(val); });
    expect(seen).toEqual(["only"]);
    expect(waterfallSync([], () => "never", "seed")).toBe("seed");
  });

  it("returns undefined when no seed is given", () => {
    expect(waterfallSync([1, 2], () => undefined)).toBeUndefined();
  });
});
