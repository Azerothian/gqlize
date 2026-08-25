import { describe, it, expect, jest } from "@jest/globals";
import createRoleBasedPermissions, { ROLE_BASED_GATES } from "../src/permissions";
import { PERMISSION_KEYS } from "../src/gate";

describe("utilize - createRoleBasedPermissions", () => {
  it("no rules for role + defaultDeny (default) denies", () => {
    const permission = createRoleBasedPermissions("anything", {});
    expect(permission.model!("Task")).toBeFalsy();
  });

  it("model: allow permits every model", () => {
    const permission = createRoleBasedPermissions("user", { user: { model: "allow" } });
    expect(permission.model!("Task")).toBe(true);
    expect(permission.model!("Item")).toBe(true);
  });

  it("field rules gate per model/field", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { field: { Task: { name: "deny" } } } },
      { defaultDeny: false }
    );
    expect(permission.field!("Task", "name")).toBe(false);
    expect(permission.field!("Task", "other")).toBe(true); // defaultDeny:false -> allow
    expect(permission.field!("Other", "x")).toBe(true);
  });

  it("defaultDeny:true denies unlisted fields", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { field: { Task: { name: "allow" } } } },
      { defaultDeny: true }
    );
    expect(permission.field!("Task", "name")).toBe(true);
    expect(permission.field!("Task", "unlisted")).toBe(false);
  });

  it("mutationCreate can deny a specific model", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { model: "allow", mutationCreate: { Task: "deny" } } },
      { defaultDeny: false }
    );
    expect(permission.mutationCreate!("Task")).toBe(false);
    expect(permission.mutationCreate!("Item")).toBe(true);
  });

  it("emits exactly the gates consumers read, and nothing else", () => {
    // The bug this guards: a gate nobody reads is not inert, it is open —
    // `isAllowed` treats an absent predicate as ALLOW. Emitting `subscription`
    // while never emitting `queryExtension` left extend fields ungated under
    // `defaultDeny`.
    expect(ROLE_BASED_GATES.slice().sort()).toEqual([
      "field",
      "model",
      "mutation",
      "mutationClassMethods",
      "mutationCreate",
      "mutationCreateInput",
      "mutationDelete",
      "mutationExtension",
      "mutationUpdate",
      "mutationUpdateInput",
      "query",
      "queryClassMethods",
      "queryExtension",
      "queryInstanceMethods",
      "relationship",
      "scope",
    ]);

    const unread = ROLE_BASED_GATES.filter((gate) => !(PERMISSION_KEYS as readonly string[]).includes(gate));
    expect(unread).toEqual([]);
  });

  it("defaultDeny emits every boolean gate, but never a scope", () => {
    const permission = createRoleBasedPermissions("anything", {});
    // `scope` is the one gate `defaultDeny` does not reach, and deliberately:
    // an absent scope means *unscoped*, which is what every deployment
    // predating the key already relies on. Denying every row by default would
    // make adding a rules tree a breaking change, and `model`/`query` are the
    // keys that exist to refuse the surface outright.
    expect(Object.keys(permission).sort())
      .toEqual(ROLE_BASED_GATES.filter((gate) => gate !== "scope").slice().sort());
    expect(permission.scope).toBeUndefined();
    // Read through a widened view: the retired keys are not on `Permission` any
    // more, which is itself the point — but the runtime bag still has to be free
    // of them, since an unread predicate is treated as ALLOW.
    const emitted = permission as Record<string, unknown>;
    expect(emitted.subscription).toBeUndefined();
    expect(emitted.mutationUpdateAll).toBeUndefined();
    expect(emitted.mutationDeleteAll).toBeUndefined();
    expect(emitted.extensions).toBeUndefined();
  });

  it("defaultDeny:false omits unmentioned gates so isAllowed falls through", () => {
    const permission = createRoleBasedPermissions("user", { user: { model: "allow" } }, { defaultDeny: false });
    expect(typeof permission.model).toBe("function");
    expect(permission.field).toBeUndefined();
    expect(permission.queryExtension).toBeUndefined();
  });

  it("queryExtension/mutationExtension gate extend field keys", () => {
    const denied = createRoleBasedPermissions("anon", {});
    expect(denied.queryExtension!("health")).toBe(false);
    expect(denied.mutationExtension!("ping")).toBe(false);

    const permission = createRoleBasedPermissions(
      "user",
      { user: { queryExtension: { health: "allow" } } },
      { defaultDeny: true }
    );
    // the argument is the extend field key, not a model name
    expect(permission.queryExtension!("health")).toBe(true);
    expect(permission.queryExtension!("secretStats")).toBe(false);
  });

  it("`extensions` is accepted as a synonym for both extension gates", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { extensions: { health: "allow" } } },
      { defaultDeny: true }
    );
    expect(permission.queryExtension!("health")).toBe(true);
    expect(permission.mutationExtension!("health")).toBe(true);
    expect(permission.queryExtension!("other")).toBe(false);
  });

  it("the specific extension key wins over the `extensions` synonym", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { extensions: "allow", queryExtension: { health: "deny" } } },
      { defaultDeny: true }
    );
    expect(permission.queryExtension!("health")).toBe(false);
    // no opinion from queryExtension -> falls through to the `extensions` blanket
    expect(permission.queryExtension!("other")).toBe(true);
    expect(permission.mutationExtension!("health")).toBe(true);
  });

  it("mutation input gates fall back to `field`", () => {
    const permission = createRoleBasedPermissions(
      "user",
      { user: { field: { Task: { name: "allow" } } } },
      { defaultDeny: true }
    );
    // readable -> writable, so a defaultDeny role still has usable mutations
    expect(permission.mutationCreateInput!("Task", "name")).toBe(true);
    expect(permission.mutationUpdateInput!("Task", "name")).toBe(true);
    expect(permission.mutationCreateInput!("Task", "secret")).toBe(false);
  });

  it("an explicit input deny is not overridden by an allowed field", () => {
    const permission = createRoleBasedPermissions(
      "user",
      {
        user: {
          field: { Task: "allow" },
          mutationUpdateInput: { Task: { name: "deny" } },
        },
      },
      { defaultDeny: true }
    );
    expect(permission.field!("Task", "name")).toBe(true);
    expect(permission.mutationUpdateInput!("Task", "name")).toBe(false);
    // unmentioned by mutationUpdateInput -> falls through to `field`
    expect(permission.mutationUpdateInput!("Task", "other")).toBe(true);
    // create has its own chain and is untouched
    expect(permission.mutationCreateInput!("Task", "name")).toBe(true);
  });

  it("warns about a rules key nothing reads", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createRoleBasedPermissions("user", { user: { subscription: "allow", modle: "deny" } });
      const message = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(message).toContain("subscription");
      expect(message).toContain("modle");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn about a rules tree that only uses read keys", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createRoleBasedPermissions("user", { user: { model: "allow", extensions: "allow", field: "allow" } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
