import { test, describe, it, expect } from "@jest/globals";
import {
  PERMISSION_KEYS,
  unknownPermissionKeys,
  isAllowed,
  isModelAllowed,
  isFieldAllowed,
  isRelationshipAllowed,
  isMutationAllowed,
  isInputFieldAllowed,
  type Permission,
} from "../src/gate";

describe("utilize - gate helpers", () => {
  it("isAllowed: absent (non-function) predicate allows", () => {
    expect(isAllowed(undefined)).toBe(true);
    expect(isAllowed(null)).toBe(true);
    expect(isAllowed("deny")).toBe(true); // not a function -> allow
    expect(isAllowed(() => false)).toBe(false);
    expect(isAllowed(() => true)).toBe(true);
  });

  it("isModelAllowed: absent permission / predicate allows", () => {
    expect(isModelAllowed(undefined, "Task")).toBe(true);
    expect(isModelAllowed({}, "Task")).toBe(true);
    expect(isModelAllowed({ model: () => false }, "Task")).toBe(false);
    expect(isModelAllowed({ model: (m: string) => m === "Task" }, "Task")).toBe(true);
  });

  it("isFieldAllowed: id is always allowed; predicate gates the rest", () => {
    const perm = { field: (_m: string, f: string) => f !== "secret" };
    expect(isFieldAllowed(perm, "Task", "id")).toBe(true); // id exception
    expect(isFieldAllowed(perm, "Task", "secret")).toBe(false);
    expect(isFieldAllowed(perm, "Task", "name")).toBe(true);
    expect(isFieldAllowed(undefined, "Task", "secret")).toBe(true); // absent -> allow
  });

  it("isRelationshipAllowed: passes target to the predicate", () => {
    const seen: any[] = [];
    const perm = {
      options: { role: "user" },
      relationship: (...args: any[]) => {
        seen.push(args);
        return true;
      },
    };
    expect(isRelationshipAllowed(perm, "Task", "item", "Item")).toBe(true);
    expect(seen[0]).toEqual(["Task", "item", "Item", { role: "user" }]);
    expect(isRelationshipAllowed({ relationship: () => false }, "Task", "item", "Item")).toBe(false);
    expect(isRelationshipAllowed(undefined, "Task", "item")).toBe(true);
  });

  it("isMutationAllowed: routes to mutationCreate/Update/Delete", () => {
    const perm = { mutationCreate: () => false, mutationUpdate: () => true, mutationDelete: () => false };
    expect(isMutationAllowed(perm, "Task", "create")).toBe(false);
    expect(isMutationAllowed(perm, "Task", "update")).toBe(true);
    expect(isMutationAllowed(perm, "Task", "delete")).toBe(false);
    expect(isMutationAllowed(undefined, "Task", "create")).toBe(true);
  });

  it("isInputFieldAllowed: optional predicates default to allow", () => {
    expect(isInputFieldAllowed(undefined, "Task", "name", "create")).toBe(true);
    expect(isInputFieldAllowed({}, "Task", "name", "create")).toBe(true);
    expect(isInputFieldAllowed({ mutationCreateInput: () => false }, "Task", "name", "create")).toBe(false);
    expect(isInputFieldAllowed({ mutationUpdateInput: () => false }, "Task", "name", "update")).toBe(false);
    // create predicate must not affect update
    expect(isInputFieldAllowed({ mutationCreateInput: () => false }, "Task", "name", "update")).toBe(true);
  });

  it("unknownPermissionKeys: a valid bag reports nothing", () => {
    const perm: any = {};
    PERMISSION_KEYS.forEach((key) => {
      perm[key] = () => true;
    });
    expect(unknownPermissionKeys(perm)).toEqual([]);
    expect(unknownPermissionKeys(undefined)).toEqual([]);
    expect(unknownPermissionKeys({})).toEqual([]);
    // `options` is data, not a predicate, but it is still a key we read.
    expect(unknownPermissionKeys({ options: { role: "admin" } })).toEqual([]);
  });

  it("unknownPermissionKeys: reports a typo, which would otherwise fail open", () => {
    // @ts-expect-error - `modle` is not a permission key. That this no longer
    // typechecks is half the fix; the runtime check is the other half, for JS
    // callers and bags built programmatically.
    const typo: Permission = { modle: () => false };
    expect(unknownPermissionKeys(typo)).toEqual(["modle"]);
    // the reason it matters: nothing reads `modle`, so the model is allowed.
    expect(isModelAllowed(typo, "Task")).toBe(true);
  });

  it("unknownPermissionKeys: reports keys retired in 7.0", () => {
    // @ts-expect-error - `subscription` and `extensions` were retired in 7.0
    const legacy: Permission = { model: () => true, subscription: () => false, extensions: () => false };
    expect(unknownPermissionKeys(legacy).sort()).toEqual(["extensions", "subscription"]);
  });
});
