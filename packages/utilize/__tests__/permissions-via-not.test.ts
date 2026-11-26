// Tests for the `via` leaf and `not` combinator added in Phase 1 of the
// row-security RFC.

import { describe, it, expect } from "@jest/globals";
import createRoleBasedPermissions from "../src/permissions";
import type { ScopeResult } from "../src/gate";

const ctx = (id: string) => ({ user: { id } });

describe("utilize - permissions: via sugar", () => {
  it("compiles a via path into a __via marker", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          User: {
            via: "memberships.group.memberships",
            match: { userId: "$principal.id", role: "manager" },
          },
        },
      },
    }, { defaultDeny: false });

    const result = await permission.scope!("User", "read", undefined, ctx("u1"));
    expect(result).toBeTruthy();
    const resolved = result as Exclude<ScopeResult, undefined | false>;
    const where = "where" in resolved ? resolved.where : resolved;
    expect(where).toHaveProperty("__via");
    const via = (where as { __via: { path: string[]; match: Record<string, unknown> } }).__via;
    expect(via.path).toEqual(["memberships", "group", "memberships"]);
    expect(via.match).toEqual({ userId: { eq: "u1" }, role: { eq: "manager" } });
  });

  it("denies when a $principal value is missing", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          Task: {
            via: "project.members",
            match: { userId: "$principal.id" },
          },
        },
      },
    }, { defaultDeny: false });

    // No user at all
    const result = await permission.scope!("Task", "read", undefined, {});
    expect(result).toBe(false);
  });

  it("resolves literal match values without $principal prefix", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          Task: {
            via: "project.members",
            match: { role: "admin" },
          },
        },
      },
    }, { defaultDeny: false });

    const result = await permission.scope!("Task", "read", undefined, ctx("u1"));
    expect(result).toBeTruthy();
    const resolved = result as Exclude<ScopeResult, undefined | false>;
    const where = "where" in resolved ? resolved.where : resolved;
    const via = (where as { __via: { match: Record<string, unknown> } }).__via;
    expect(via.match.role).toEqual({ eq: "admin" });
  });
});

describe("utilize - permissions: not combinator", () => {
  it("wraps a scope leaf in a portable not", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          Membership: {
            write: {
              all: [
                { own: "groupId" },
                { not: { own: "userId" } },
              ],
            },
          },
        },
      },
    }, { defaultDeny: false, principal: (c) => (c as { user: { id: string } }).user });

    const result = await permission.scope!("Membership", "update", undefined, ctx("u1"));
    expect(result).toBeTruthy();
    const resolved = result as { where: Record<string, unknown> };
    expect(resolved.where).toHaveProperty("and");
    const branches = (resolved.where as { and: Record<string, unknown>[] }).and;
    expect(branches).toHaveLength(2);
    // The second branch should be a `not` wrapping {userId: {eq: "u1"}}
    expect(branches[1]).toHaveProperty("not");
    const negated = (branches[1] as { not: Record<string, unknown> }).not;
    expect(negated).toEqual({ userId: { eq: "u1" } });
  });

  it("not of a deny still denies (never widens)", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          // `own: { field: "ownerId", from: "missingKey" }` means compare
          // the model's ownerId against the principal's missingKey — which the
          // principal doesn't have, so `own` denies. Under `not`, that deny
          // must stay a deny (never widen to "allow everything").
          Task: { not: { own: { field: "ownerId", from: "missingKey" } } },
        },
      },
    }, {
      defaultDeny: false,
      principal: () => ({ id: "u1" }),
    });

    const result = await permission.scope!("Task", "read", undefined, ctx("u1"));
    expect(result).toBe(false);
  });

  it("not of undefined (no opinion) is undefined", async () => {
    const permission = createRoleBasedPermissions("member", {
      member: {
        scope: {
          Task: { not: "allow" },
        },
      },
    }, { defaultDeny: false });

    const result = await permission.scope!("Task", "read", undefined, ctx("u1"));
    expect(result).toBeUndefined();
  });
});

describe("utilize - permissions: via + not in the group-manager example", () => {
  it("compiles the RFC example rules", async () => {
    const managesUser = {
      via: "memberships.group.memberships",
      match: { userId: "$principal.id", role: "manager" },
    };

    const rules = {
      member: {
        scope: {
          User: { any: [{ own: "id" }, managesUser] },
          Group: { via: "memberships", match: { userId: "$principal.id" } },
          Membership: {
            read: { via: "group.memberships", match: { userId: "$principal.id" } },
            write: {
              all: [
                { via: "group.memberships", match: { userId: "$principal.id", role: "manager" } },
                { not: { own: "userId" } },
              ],
            },
          },
        },
      },
    };

    const permission = createRoleBasedPermissions("member", rules, {
      defaultDeny: false,
      principal: (c) => (c as { user: { id: string } }).user,
    });

    // User scope: `any` of [own id, via memberships path]
    const userResult = await permission.scope!("User", "read", undefined, ctx("u1"));
    expect(userResult).toBeTruthy();
    const userWhere = (userResult as { where: Record<string, unknown> }).where;
    expect(userWhere).toHaveProperty("or");
    const branches = (userWhere as { or: unknown[] }).or;
    expect(branches).toHaveLength(2);
    // First branch: own id
    expect(branches[0]).toEqual({ id: { eq: "u1" } });
    // Second branch: via marker
    expect(branches[1]).toHaveProperty("__via");

    // Membership write scope: all of [via path, not own userId]
    const membershipResult = await permission.scope!("Membership", "update", undefined, ctx("u1"));
    expect(membershipResult).toBeTruthy();
    const mWhere = (membershipResult as { where: Record<string, unknown> }).where;
    expect(mWhere).toHaveProperty("and");
    const mBranches = (mWhere as { and: unknown[] }).and;
    expect(mBranches).toHaveLength(2);
    // Second branch: not own userId
    expect(mBranches[1]).toHaveProperty("not");
    expect((mBranches[1] as { not: Record<string, unknown> }).not).toEqual({ userId: { eq: "u1" } });
  });
});
