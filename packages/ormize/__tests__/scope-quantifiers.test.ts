// Relationship quantifiers in row-level scope: Phase 1 of the row-security RFC.
//
// Tests that quantifiers (some, none, every, is, isNot) in a scope's
// PortableWhere are compiled to correlated EXISTS/NOT EXISTS subqueries by the
// Sequelize adapter, that the cross-adapter check rejects quantifiers spanning
// adapters, and that the via sugar resolves into proper quantifier nesting.

import { describe, it, expect } from "@jest/globals";
import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import { dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx = (id: string) => ({ user: { id } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helpers read adapter instances by field name
type AnyRow = any;

/**
 * Build a User -> Membership -> Group model set for quantifier testing.
 * User hasMany Membership; Membership belongsTo User, belongsTo Group;
 * Group hasMany Membership.
 */
async function buildGroupManager(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
} = {}) {
  const permission = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({
    permission,
    onScopeMiss: options.onScopeMiss,
  });
  db.registerAdapter(
    trackConnection(new SequelizeAdapter({}, await dialectConfig())),
    "sqlite",
  );
  await db.addDefinition({
    name: "User",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
    },
    options: { timestamps: false, tableName: "users" },
    relationships: [
      { type: "hasMany", model: "Membership", name: "memberships", options: { foreignKey: "userId" } },
    ],
  });
  await db.addDefinition({
    name: "Group",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
    },
    options: { timestamps: false, tableName: "groups" },
    relationships: [
      { type: "hasMany", model: "Membership", name: "memberships", options: { foreignKey: "groupId" } },
    ],
  });
  await db.addDefinition({
    name: "Membership",
    define: {
      userId: { type: Sequelize.INTEGER, allowNull: false },
      groupId: { type: Sequelize.INTEGER, allowNull: false },
      role: { type: Sequelize.STRING, allowNull: false, defaultValue: "member" },
    },
    options: { timestamps: false, tableName: "memberships" },
    relationships: [
      { type: "belongsTo", model: "User", name: "user", options: { foreignKey: "userId" } },
      { type: "belongsTo", model: "Group", name: "group", options: { foreignKey: "groupId" } },
    ],
  });
  await db.initialise();
  await db.sync();
  return db;
}

type Orm = Awaited<ReturnType<typeof buildGroupManager>>;

/**
 * Seed the group-manager scenario from RFC §7:
 * - u1 (Alice), u2 (Bob), u3 (Charlie)
 * - g1 (Engineering), g2 (Marketing)
 * - Memberships: Alice is manager of g1, Bob is member of g1,
 *   Charlie is manager of g2.
 */
async function seedGroupManager(db: Orm) {
  const alice = await db.models.User.create({ name: "Alice" });
  const bob = await db.models.User.create({ name: "Bob" });
  const charlie = await db.models.User.create({ name: "Charlie" });
  const engineering = await db.models.Group.create({ name: "Engineering" });
  const marketing = await db.models.Group.create({ name: "Marketing" });
  await db.models.Membership.bulkCreate([
    { userId: alice.id, groupId: engineering.id, role: "manager" },
    { userId: bob.id, groupId: engineering.id, role: "member" },
    { userId: charlie.id, groupId: marketing.id, role: "manager" },
  ]);
  return { alice, bob, charlie, engineering, marketing };
}

// ---------------------------------------------------------------------------
// hasMany: some/none/every
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: hasMany", () => {
  it("some: returns users who have at least one membership", async () => {
    const scope: ScopePredicate = () => ({
      where: { memberships: { some: {} } },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    // Create a user with no memberships
    await db.models.User.create({ name: "Nobody" });

    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(3);
    const names = results.models.map((r: AnyRow) => r.name as string).sort();
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("some with inner filter: returns users with a manager membership", async () => {
    const scope: ScopePredicate = () => ({
      where: { memberships: { some: { role: { eq: "manager" } } } },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);

    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(2);
    const names = results.models.map((r: AnyRow) => r.name as string).sort();
    expect(names).toEqual(["Alice", "Charlie"]);
  });

  it("none: returns users with no memberships", async () => {
    const scope: ScopePredicate = () => ({
      where: { memberships: { none: {} } },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });

    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).name).toBe("Nobody");
  });

  it("every: returns users where every membership is manager", async () => {
    const scope: ScopePredicate = () => ({
      where: { memberships: { every: { role: { eq: "manager" } } } },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    // Nobody has zero memberships — every is vacuously true
    await db.models.User.create({ name: "Nobody" });

    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    // Alice (all manager), Charlie (all manager), Nobody (vacuously true)
    // Bob has a "member" membership, so he's excluded
    const names = results.models.map((r: AnyRow) => r.name as string).sort();
    expect(names).toEqual(["Alice", "Charlie", "Nobody"]);
  });
});

// ---------------------------------------------------------------------------
// belongsTo: is/isNot
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: belongsTo", () => {
  it("is: returns memberships whose user matches", async () => {
    const scope: ScopePredicate = () => ({
      where: { user: { is: { name: { eq: "Alice" } } } },
    });
    const db = await buildGroupManager({ scope });
    const { alice } = await seedGroupManager(db);

    const results = await db.resolveFindAll("Membership", null, {}, ctx(String(alice.id)));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).userId).toBe(alice.id);
  });

  it("isNot: returns memberships whose user doesn't match", async () => {
    const scope: ScopePredicate = () => ({
      where: { user: { isNot: { name: { eq: "Alice" } } } },
    });
    const db = await buildGroupManager({ scope });
    const { bob, charlie } = await seedGroupManager(db);

    const results = await db.resolveFindAll("Membership", null, {}, ctx("any"));
    expect(results.total).toBe(2);
    const userIds = results.models.map((r: AnyRow) => r.userId).sort();
    expect(userIds).toEqual([bob.id, charlie.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Nesting: quantifiers inside quantifiers
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: nesting", () => {
  it("nested quantifiers: users in a group that has a manager", async () => {
    // "Users who have a membership in a group that has at least one manager"
    const scope: ScopePredicate = () => ({
      where: {
        memberships: {
          some: {
            group: {
              is: {
                memberships: {
                  some: { role: { eq: "manager" } },
                },
              },
            },
          },
        },
      },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);

    // Alice and Bob are both in Engineering (which has Alice as manager)
    // Charlie is in Marketing (which has Charlie as manager)
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(3);
    const names = results.models.map((r: AnyRow) => r.name as string).sort();
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("RFC §7 group-manager scope: users I manage", async () => {
    // The worked example: a manager sees their own row + users in groups
    // they manage.
    const scope: ScopePredicate = (_defName, _op, _opts, context) => {
      const userId = (context as { user: { id: string } }).user.id;
      return {
        where: {
          or: [
            { id: { eq: userId } },
            {
              memberships: {
                some: {
                  group: {
                    is: {
                      memberships: {
                        some: { userId: { eq: userId }, role: { eq: "manager" } },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };
    };
    const db = await buildGroupManager({ scope });
    const { alice, bob } = await seedGroupManager(db);

    // Alice manages Engineering -> sees herself + Bob (member of Engineering)
    const aliceResults = await db.resolveFindAll("User", null, {}, ctx(String(alice.id)));
    const aliceNames = aliceResults.models.map((r: AnyRow) => r.name as string).sort();
    expect(aliceNames).toEqual(["Alice", "Bob"]);

    // Bob manages nothing -> sees only himself
    const bobResults = await db.resolveFindAll("User", null, {}, ctx(String(bob.id)));
    const bobNames = bobResults.models.map((r: AnyRow) => r.name as string).sort();
    expect(bobNames).toEqual(["Bob"]);
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter check
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: cross-adapter rejection", () => {
  it("throws ScopeConfigurationError for a quantifier across adapters", async () => {
    const scope: ScopePredicate = () => ({
      where: { files: { some: {} } },
    });
    const db = new Database({ permission: { scope } });
    db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
    db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite2");
    await db.addDefinition({
      name: "Vault",
      define: { title: { type: Sequelize.STRING, allowNull: true } },
      options: { timestamps: false, tableName: "vaults" },
      relationships: [
        { type: "hasMany", model: "File", name: "files", options: { foreignKey: "vaultId" } },
      ],
    }, "sqlite");
    await db.addDefinition({
      name: "File",
      define: {
        name: { type: Sequelize.STRING, allowNull: false },
        vaultId: { type: Sequelize.INTEGER, allowNull: true },
      },
      options: { timestamps: false, tableName: "files" },
    }, "sqlite2");
    await db.initialise();
    await db.sync();

    await expect(
      db.resolveFindAll("Vault", null, {}, ctx("any")),
    ).rejects.toThrow(ScopeConfigurationError);
    await expect(
      db.resolveFindAll("Vault", null, {}, ctx("any")),
    ).rejects.toThrow("different adapter");
  });
});

// ---------------------------------------------------------------------------
// Via sugar resolution
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: via sugar resolution", () => {
  it("resolves via path into proper quantifier nesting", async () => {
    // Via "memberships.group.memberships" with match = manager
    // memberships is hasMany -> some
    // group is belongsTo -> is
    // memberships is hasMany -> some
    const scope: ScopePredicate = (_defName, _op, _opts, context) => {
      const userId = (context as { user: { id: string } }).user.id;
      return {
        where: {
          __via: {
            path: ["memberships", "group", "memberships"],
            match: { userId: { eq: userId }, role: { eq: "manager" } },
          },
        },
      };
    };
    const db = await buildGroupManager({ scope });
    const { alice } = await seedGroupManager(db);

    // Alice manages Engineering, so users in Engineering should be visible
    const results = await db.resolveFindAll("User", null, {}, ctx(String(alice.id)));
    const names = results.models.map((r: AnyRow) => r.name as string).sort();
    expect(names).toEqual(["Alice", "Bob"]);
  });
});

// ---------------------------------------------------------------------------
// Write path: nested-write re-check ordering
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: write re-check after nested writes", () => {
  it("update with quantifier scope narrows the write", async () => {
    // A scope using a quantifier on the update path: only users with at least
    // one membership can be updated.
    const scope: ScopePredicate = (_defName, operation) => {
      if (_defName !== "User") {
        return undefined;
      }
      return { where: { memberships: { some: {} } } };
    };
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    // Add a user with no memberships
    await db.models.User.create({ name: "Nobody" });

    // Update all users: only the ones with memberships should be affected
    await db.processUpdate("User", null, { input: { name: "Updated" }, where: {} }, ctx("admin"));
    const all = (await db.models.User.findAll({})) as AnyRow[];
    const updated = all.filter((r: AnyRow) => r.name === "Updated");
    const unchanged = all.filter((r: AnyRow) => r.name === "Nobody");
    expect(updated).toHaveLength(3); // Alice, Bob, Charlie
    expect(unchanged).toHaveLength(1); // Nobody
  });
});
