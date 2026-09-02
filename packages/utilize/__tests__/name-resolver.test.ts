import { describe, expect, it } from "@jest/globals";
import { createNameResolver } from "../src/utils/name-resolver";

// This is a security control: the input is attacker-supplied (a `:resource` URL
// segment, a model name in workflow input) and an unknown one must come back
// `undefined` so the caller can refuse it. The prototype-pollution cases below
// are the reason it exists once rather than twice.
describe("createNameResolver", () => {
  const resolver = createNameResolver(["Task", "TaskItem"]);

  it("resolves an exact name", () => {
    expect(resolver.resolve("Task")).toBe("Task");
  });

  it("resolves case-insensitively", () => {
    expect(resolver.resolve("task")).toBe("Task");
    expect(resolver.resolve("TASKITEM")).toBe("TaskItem");
  });

  it("returns undefined for an unknown name", () => {
    expect(resolver.resolve("Nope")).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"])(
    "does not resolve the inherited member %s",
    (key) => {
      // A plain object would hand back a function here, which reads as "known"
      // to every caller and walks straight past the unknown-name check.
      expect(resolver.resolve(key)).toBeUndefined();
    },
  );

  it.each([
    ["a number", 1],
    ["an object", {}],
    ["an array", []],
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["a boolean", true],
  ])("fails closed on %s", (_label, input) => {
    expect(resolver.resolve(input)).toBeUndefined();
  });

  it("reports its known names without exposing the backing array", () => {
    const names = resolver.names();
    expect(names).toEqual(["Task", "TaskItem"]);
    names.push("Injected");
    expect(resolver.names()).toEqual(["Task", "TaskItem"]);
  });

  it("is unaffected by a later mutation of the source array", () => {
    const source = ["Task"];
    const r = createNameResolver(source);
    source.push("Sneaky");
    expect(r.names()).toEqual(["Task"]);
    expect(r.resolve("Sneaky")).toBeUndefined();
  });
});
