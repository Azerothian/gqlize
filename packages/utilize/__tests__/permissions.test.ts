import { test, describe, it, expect } from "@jest/globals";
import createRoleBasedPermissions from "../src/permissions";

describe("utilize - createRoleBasedPermissions", () => {
  it("no rules for role + defaultDeny (default) denies", () => {
    const permission = createRoleBasedPermissions("anything", {});
    expect(permission.model("Task")).toBeFalsy();
  });

  it("model: allow permits every model", () => {
    const permission = createRoleBasedPermissions("user", { user: { model: "allow" } });
    expect(permission.model("Task")).toBe(true);
    expect(permission.model("Item")).toBe(true);
  });

  it("field rules gate per model/field", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { field: { Task: { name: "deny" } } } },
      { defaultDeny: false }
    );
    expect(permission.field("Task", "name")).toBe(false);
    expect(permission.field("Task", "other")).toBe(true); // defaultDeny:false -> allow
    expect(permission.field("Other", "x")).toBe(true);
  });

  it("defaultDeny:true denies unlisted fields", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { field: { Task: { name: "allow" } } } },
      { defaultDeny: true }
    );
    expect(permission.field("Task", "name")).toBe(true);
    expect(permission.field("Task", "unlisted")).toBe(false);
  });

  it("mutationCreate can deny a specific model", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { model: "allow", mutationCreate: { Task: "deny" } } },
      { defaultDeny: false }
    );
    expect(permission.mutationCreate("Task")).toBe(false);
    expect(permission.mutationCreate("Item")).toBe(true);
  });
});
