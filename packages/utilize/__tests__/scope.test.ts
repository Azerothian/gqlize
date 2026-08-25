import { describe, it, expect, jest } from "@jest/globals";
import createRoleBasedPermissions, {
  type Principal, type RoleBasedPermissionOptions, type RoleRules,
} from "../src/permissions";
import { assertFilterAllowed, type Fail } from "../src/guards";
import {
  BUILD_TIME_PERMISSION_KEYS,
  PERMISSION_KEYS,
  RESOLUTION_TIME_PERMISSION_KEYS,
  ScopeConfigurationError,
  andScopes,
  isAllowed,
  mergeScopeWhere,
  normaliseScopeWhere,
  resolveScope,
  type Permission,
  type PermissionContext,
  type PortableWhere,
  type ScopePredicate,
} from "../src/gate";

const ctx = { user: { id: "u1", tenantId: "t1", groupIds: ["g1", "g2"] } };

describe("scope - the key split", () => {
  it("partitions PERMISSION_KEYS exactly once", () => {
    const build = new Set<string>(BUILD_TIME_PERMISSION_KEYS);
    const resolution = new Set<string>(RESOLUTION_TIME_PERMISSION_KEYS);
    expect([...resolution].filter((key) => build.has(key))).toEqual([]);
    expect([...PERMISSION_KEYS].slice().sort())
      .toEqual([...build, ...resolution].sort());
  });

  it("puts scope on the resolution-time side", () => {
    // The whole reason `scope` may be async. A schema builder cannot await, so
    // a resolution-time key reached at build time resolves to a pending promise
    // — which coerces to `true`, i.e. to an unrestricted query.
    expect([...RESOLUTION_TIME_PERMISSION_KEYS]).toEqual(["scope"]);
  });
});

describe("scope - isAllowed refuses to coerce one", () => {
  it("throws when a build-time predicate returns a filter", () => {
    // Without this the sharpest edge in the feature is silent: `!!{ownerId: …}`
    // is `true`, and a filter coerced to true is an unrestricted query.
    expect(() => isAllowed(() => ({ ownerId: { eq: "u1" } }))).toThrow(TypeError);
    expect(() => isAllowed(() => ({ ownerId: { eq: "u1" } }))).toThrow(/permission\.scope/);
  });

  it("throws when a build-time predicate returns a promise", () => {
    expect(() => isAllowed(() => Promise.resolve(true))).toThrow(/synchronous/);
  });

  it("still accepts booleans, and null/undefined as falsy", () => {
    expect(isAllowed(() => true)).toBe(true);
    expect(isAllowed(() => false)).toBe(false);
    expect(isAllowed(() => undefined)).toBe(false);
    expect(isAllowed(() => null)).toBe(false);
  });
});

describe("scope - mergeScopeWhere", () => {
  it("wraps in `and` rather than spreading, on a shared key", () => {
    // F10. A spread clobbers in whichever direction the author happened to
    // write it; only a fresh `and` keeps both constraints.
    const merged = mergeScopeWhere({ ownerId: { eq: "u2" } }, { ownerId: { eq: "u1" } });
    expect(merged).toEqual({ and: [{ ownerId: { eq: "u2" } }, { ownerId: { eq: "u1" } }] });
  });

  it("nests an existing `and` rather than concatenating into it", () => {
    // Concatenating would let a caller's crafted `and` shape decide where the
    // scope lands. The scope is always its own branch.
    const userWhere = { and: [{ a: { eq: 1 } }, { b: { eq: 2 } }] };
    const merged = mergeScopeWhere(userWhere, { ownerId: { eq: "u1" } }) as { and: PortableWhere[] };
    expect(merged.and).toHaveLength(2);
    expect(merged.and[0]).toBe(userWhere);
    expect(merged.and[1]).toEqual({ ownerId: { eq: "u1" } });
  });

  it("passes each side through untouched when the other is empty", () => {
    expect(mergeScopeWhere(undefined, { a: { eq: 1 } })).toEqual({ a: { eq: 1 } });
    expect(mergeScopeWhere({}, { a: { eq: 1 } })).toEqual({ a: { eq: 1 } });
    expect(mergeScopeWhere({ a: { eq: 1 } }, undefined)).toEqual({ a: { eq: 1 } });
    expect(mergeScopeWhere({ a: { eq: 1 } }, {})).toEqual({ a: { eq: 1 } });
  });

  it("lowercases logical operators on the way in", () => {
    // `guards.ts` matches combinators lowercased, so `AND` would take a
    // different path through filter validation — and an adapter dispatching on
    // the exact key would read it as a field name.
    expect(normaliseScopeWhere({ AND: [{ Or: [{ a: { eq: 1 } }] }, { NOT: { b: { eq: 2 } } }] }))
      .toEqual({ and: [{ or: [{ a: { eq: 1 } }] }, { not: { b: { eq: 2 } } }] });
    expect(mergeScopeWhere({ a: { eq: 1 } }, { OR: [{ b: { eq: 2 } }] }))
      .toEqual({ and: [{ a: { eq: 1 } }, { or: [{ b: { eq: 2 } }] }] });
  });

  it("leaves field names that merely look like operators alone", () => {
    // Only the three combinators are rewritten; a column called `Android` is a
    // column.
    expect(normaliseScopeWhere({ Android: { eq: true } })).toEqual({ Android: { eq: true } });
  });
});

describe("scope - resolveScope", () => {
  const bag = (scope: ScopePredicate | undefined, options?: PermissionContext): Permission =>
    ({ scope, options });

  it("imposes nothing when the key is absent", async() => {
    expect(await resolveScope(undefined, "Task", "read", ctx)).toBeUndefined();
    expect(await resolveScope({}, "Task", "read", ctx)).toBeUndefined();
  });

  it("imposes nothing when the predicate has no opinion", async() => {
    expect(await resolveScope(bag(() => undefined), "Task", "read", ctx)).toBeUndefined();
  });

  it("returns false for an explicit deny", async() => {
    expect(await resolveScope(bag(() => false), "Task", "read", ctx)).toBe(false);
  });

  it("wraps a bare filter into an envelope", async() => {
    expect(await resolveScope(bag(() => ({ ownerId: { eq: "u1" } })), "Task", "read", ctx))
      .toEqual({ where: { ownerId: { eq: "u1" } } });
  });

  it("passes the envelope form through, normalised", async() => {
    expect(await resolveScope(bag(() => ({ where: { OR: [{ a: { eq: 1 } }] } })), "Task", "read", ctx))
      .toEqual({ where: { or: [{ a: { eq: 1 } }] }, set: undefined, native: undefined });
  });

  it("awaits an async predicate", async() => {
    const scope: ScopePredicate = () => Promise.resolve({ ownerId: { eq: "u1" } });
    expect(await resolveScope(bag(scope), "Task", "read", ctx)).toEqual({ where: { ownerId: { eq: "u1" } } });
  });

  it("hands the predicate the build-time bag and the request context", async() => {
    const scope = jest.fn(() => undefined) as unknown as ScopePredicate;
    const options = { role: "member" };
    await resolveScope(bag(scope, options), "Task", "update", ctx);
    expect(scope).toHaveBeenCalledWith("Task", "update", options, ctx);
  });

  it("denies when the predicate throws", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Propagating would put a 500 in front of an edge that may retry the
      // request unauthenticated.
      const scope: ScopePredicate = () => { throw new Error("membership lookup failed"); };
      expect(await resolveScope(bag(scope), "Task", "read", ctx)).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Task/read");
    } finally {
      warn.mockRestore();
    }
  });

  it("rethrows a ScopeConfigurationError instead of denying", async() => {
    // F2. valkey refuses an `or` whose branches are not index-resolvable; if
    // that became a deny, the deployment would get empty result sets where it
    // should get a stack trace.
    const scope: ScopePredicate = () => { throw new ScopeConfigurationError("or is not expressible here"); };
    await expect(resolveScope(bag(scope), "Task", "read", ctx)).rejects.toThrow(ScopeConfigurationError);
  });

  it("refuses a return value that is neither a filter nor a decision", async() => {
    // `true` is the tempting mistake: it reads as "allowed" and would mean
    // unscoped, arrived at by accident rather than on purpose.
    await expect(resolveScope(bag((() => true) as unknown as ScopePredicate), "Task", "read", ctx))
      .rejects.toThrow(ScopeConfigurationError);
    await expect(resolveScope(bag((() => "yes") as unknown as ScopePredicate), "Task", "read", ctx))
      .rejects.toThrow(ScopeConfigurationError);
  });
});

describe("scope - andScopes", () => {
  const run = (scope: ScopePredicate, operation: "read" | "create" = "read") =>
    scope("Task", operation, undefined, ctx);

  it("ANDs the surviving filters", async() => {
    const combined = andScopes(
      () => ({ ownerId: { eq: "u1" } }),
      () => ({ tenantId: { eq: "t1" } }),
    );
    expect(await run(combined)).toEqual({ where: { and: [{ ownerId: { eq: "u1" } }, { tenantId: { eq: "t1" } }] } });
  });

  it("short-circuits on a deny", async() => {
    const second = jest.fn(() => ({ tenantId: { eq: "t1" } }));
    const combined = andScopes(() => false, second);
    expect(await run(combined)).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });

  it("skips sources with no opinion", async() => {
    const combined = andScopes(() => undefined, () => ({ ownerId: { eq: "u1" } }), undefined);
    expect(await run(combined)).toEqual({ where: { ownerId: { eq: "u1" } } });
  });

  it("has no opinion when no source does", async() => {
    expect(await run(andScopes(() => undefined, undefined))).toBeUndefined();
  });

  it("denies when two sources force different values for one field", async() => {
    // §9.7. Two different forced owners is a contradiction; silently picking
    // one is the worst available answer, and symmetrical with the `writable`
    // conflict on a create.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const combined = andScopes(
        () => ({ set: { ownerId: "u1" } }),
        () => ({ set: { ownerId: "u2" } }),
      );
      expect(await run(combined, "create")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("merges agreeing `set` values", async() => {
    const combined = andScopes(
      () => ({ set: { ownerId: "u1" } }),
      () => ({ set: { ownerId: "u1", tenantId: "t1" } }),
    );
    expect(await run(combined, "create")).toEqual({ set: { ownerId: "u1", tenantId: "t1" } });
  });
});

describe("scope - createRoleBasedPermissions sugar", () => {
  const compile = (
    rules: RoleRules, role = "member", options: RoleBasedPermissionOptions = {},
  ) => createRoleBasedPermissions(role, rules, options).scope!;

  it("compiles `own` to a filter for reads and a forced value for creates", () => {
    const scope = compile({ member: { scope: { Task: { own: "ownerId" } } } });
    expect(scope("Task", "read", undefined, ctx)).toEqual({ where: { ownerId: { eq: "u1" } } });
    // A create has no `where` to narrow — it supplies the value instead. The
    // structural guard is the other half: `ownerId` is an FK, so the client
    // could not have sent one anyway.
    expect(scope("Task", "create", undefined, ctx)).toEqual({ set: { ownerId: "u1" } });
  });

  it("has no opinion about a model the rules do not mention", () => {
    const scope = compile({ member: { scope: { Task: { own: "ownerId" } } } });
    expect(scope("Project", "read", undefined, ctx)).toBeUndefined();
  });

  it("splits read from write, and lets one operation override `write`", () => {
    const scope = compile({
      member: {
        scope: {
          Task: {
            read: { any: [{ own: "ownerId" }, { group: "groupId" }] },
            write: { own: "ownerId" },
            delete: "deny",
          },
        },
      },
    });
    expect(scope("Task", "read", undefined, ctx))
      .toEqual({ where: { or: [{ ownerId: { eq: "u1" } }, { groupId: { in: ["g1", "g2"] } }] } });
    expect(scope("Task", "update", undefined, ctx)).toEqual({ where: { ownerId: { eq: "u1" } } });
    expect(scope("Task", "delete", undefined, ctx)).toBe(false);
  });

  it("normalises empty group membership to a deny rather than `in: []`", () => {
    // §9.4. `{groupId: {in: []}}` is "match nothing" spelled as a filter —
    // returned alone it is a deny that reads like a bug, and some adapters
    // cannot express it at all.
    const scope = compile({ member: { scope: { Task: { group: "groupId" } } } });
    expect(scope("Task", "read", undefined, { user: { id: "u1", groupIds: [] } })).toBe(false);
    expect(scope("Task", "read", undefined, { user: { id: "u1" } })).toBe(false);
  });

  it("constrains rather than forces a value when a group scope meets a create", () => {
    // The one leaf that does not switch to `set` on a create: "one of your
    // groups" names a set, not a value, so there is nothing to force. The
    // engine's half of the contract is to *check* the create against this
    // `where` rather than merge it into a query that does not exist.
    const scope = compile({ member: { scope: { Task: { group: "groupId" } } } });
    expect(scope("Task", "create", undefined, ctx))
      .toEqual({ where: { groupId: { in: ["g1", "g2"] } } });
  });

  it("keeps an alternation alive when one branch is a dead group", () => {
    const scope = compile({
      member: { scope: { Task: { any: [{ own: "ownerId" }, { group: "groupId" }] } } },
    });
    expect(scope("Task", "read", undefined, { user: { id: "u1", groupIds: [] } }))
      .toEqual({ where: { ownerId: { eq: "u1" } } });
  });

  it("compiles `tenant` off its own principal key", () => {
    const scope = compile({ member: { scope: { Task: { tenant: "tenantId" } } } });
    expect(scope("Task", "read", undefined, ctx)).toEqual({ where: { tenantId: { eq: "t1" } } });
    expect(scope("Task", "create", undefined, ctx)).toEqual({ set: { tenantId: "t1" } });
  });

  it("accepts the long ref form when field and principal key differ", () => {
    const scope = compile({
      member: { scope: { Task: { own: { field: "createdBy", from: "id" } } } },
    });
    expect(scope("Task", "read", undefined, ctx)).toEqual({ where: { createdBy: { eq: "u1" } } });
  });

  it("denies when there is no principal at all", () => {
    const scope = compile({ member: { scope: { Task: { own: "ownerId" } } } });
    expect(scope("Task", "read", undefined, {})).toBe(false);
  });

  it("reads the principal through a supplied reader", () => {
    const scope = compile(
      { member: { scope: { Task: { own: "ownerId" } } } },
      "member",
      { principal: (context) => (context as { session?: { account?: Principal } })?.session?.account },
    );
    expect(scope("Task", "read", undefined, { session: { account: { id: "acct" } } }))
      .toEqual({ where: { ownerId: { eq: "acct" } } });
  });

  it("treats `none` as explicitly unscoped, and `deny` as a blanket refusal", () => {
    // `none` has to exist as a spelling: an absent scope key already means
    // unscoped, so without it "admin sees everything" and "nobody configured
    // this yet" would be the same rules tree.
    expect(compile({ admin: { scope: "none" } }, "admin")("Task", "read", undefined, ctx)).toBeUndefined();
    expect(compile({ locked: { scope: "deny" } }, "locked")("Task", "read", undefined, ctx)).toBe(false);
  });

  it("does not warn about `scope` as an unread rules key", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createRoleBasedPermissions("member", { member: { scope: { Task: { own: "ownerId" } } } });
      const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).not.toContain("scope");
    } finally {
      warn.mockRestore();
    }
  });

  it("emits nothing at all when no rule mentions scope", () => {
    // The asymmetry that keeps this key backwards compatible: `defaultDeny`
    // does not reach it, because an absent scope means unscoped.
    expect(createRoleBasedPermissions("member", { member: { query: "allow" } }).scope).toBeUndefined();
  });
});

describe("scope - F11: filter validation runs on caller input only", () => {
  // The ordering this pins lives in `ormize`, which imports neither `guards.ts`
  // nor this file. Nothing in `utilize` can enforce it, so it is written down
  // here as the contract both halves are built against: whatever `ormize` does,
  // `assertFilterAllowed` must never be handed a filter with a scope in it.
  const permission: Permission = {
    // `ownerId` is exactly the kind of field a scope filters on and a caller
    // may not read - an FK to the principal.
    field: (_defName: string, fieldName: string) => fieldName !== "ownerId",
  };

  // `Fail` is declared to return `never` because every real host throws; a
  // collecting stub has to throw too, or the guard would carry on validating a
  // filter its caller has already rejected.
  class Denied extends Error {}

  const check = (where: unknown): string[] => {
    const codes: string[] = [];
    const fail: Fail = (kind) => {
      codes.push(kind);
      throw new Denied(kind);
    };
    try {
      assertFilterAllowed(permission, "Task", where, fail);
    } catch (error) {
      if (!(error instanceof Denied)) {
        throw error;
      }
    }
    return codes;
  };

  it("rejects a caller filtering on a denied field", () => {
    expect(check({ ownerId: { eq: "u1" } })).toEqual(["denied-field"]);
    expect(check({ or: [{ title: { eq: "a" } }, { ownerId: { eq: "u1" } }] })).toEqual(["denied-field"]);
  });

  it("would reject the merged filter, which is why the merge comes after", () => {
    // Not an aspiration - the demonstration. If the scope were merged first the
    // guard would reject the engine's own clause, and the only scopes that
    // survived would be the ones filtering on publicly readable fields.
    expect(check(mergeScopeWhere({ title: { eq: "a" } }, { ownerId: { eq: "u1" } })))
      .toEqual(["denied-field"]);
    expect(check({ title: { eq: "a" } })).toEqual([]);
  });
});
