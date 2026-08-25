import { beforeAll, describe, expect, it } from "@jest/globals";
import { createRoleBasedPermissions } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import { TemporalizeRegistry } from "../src/registry";
import { buildOrm } from "./helper";

describe("TemporalizeRegistry", () => {
  let orm: Ormize;
  beforeAll(async () => {
    orm = await buildOrm();
  });

  it("resolves a model by exact and lower-cased name", () => {
    const registry = new TemporalizeRegistry(orm);
    expect(registry.resolve("Task")).toBe("Task");
    expect(registry.resolve("task")).toBe("Task");
  });

  it("does not resolve inherited Object members", () => {
    // The model name arrives from workflow input, so the lookup map is
    // null-prototype: these must miss rather than return a function.
    const registry = new TemporalizeRegistry(orm);
    for (const key of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
      expect(registry.resolve(key)).toBeUndefined();
    }
  });

  it("rejects non-string and empty model names", () => {
    const registry = new TemporalizeRegistry(orm);
    expect(registry.resolve("")).toBeUndefined();
    expect(registry.resolve(undefined)).toBeUndefined();
    expect(registry.resolve(42)).toBeUndefined();
    expect(registry.resolve({ toString: () => "Task" })).toBeUndefined();
  });

  it("honors the models allow-list", () => {
    const registry = new TemporalizeRegistry(orm, { models: ["Task"] });
    expect(registry.resolve("Item")).toBeUndefined();
    expect(registry.names()).toEqual(["Task"]);
  });

  it("memoizes schemas per permission identity", () => {
    const registry = new TemporalizeRegistry(orm);
    const permission = createRoleBasedPermissions("admin", { admin: { model: "allow" } }, { defaultDeny: false });
    expect(registry.schemas(permission)).toBe(registry.schemas(permission));
    expect(registry.schemas()).toBe(registry.schemas());
    expect(registry.schemas(permission)).not.toBe(registry.schemas());
  });
});
