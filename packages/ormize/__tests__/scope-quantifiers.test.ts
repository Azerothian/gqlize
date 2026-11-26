// Relationship quantifiers in row-level scope: Phase 1 of the row-security RFC.
//
// Tests that quantifiers (some, none, every, is, isNot) in a scope's
// PortableWhere are compiled to correlated EXISTS/NOT EXISTS subqueries by the
// Sequelize adapter, that the cross-adapter check rejects quantifiers spanning
// adapters, and that the via sugar resolves into proper quantifier nesting.
// Shared models: `helper/scope-quantifier-fixtures.ts`.

import { describe, it, expect } from "@jest/globals";
import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import { dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helpers read adapter instances by field name
type AnyRow = any;
const ctx = (id: string) => ({ user: { id } });

// ---------------------------------------------------------------------------
// Fixtures: User / Membership / Group
// ---------------------------------------------------------------------------

async function buildGroupManager(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
} = {}) {
  const permission = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission, onScopeMiss: options.onScopeMiss });
  db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
  await db.addDefinition({
    name: "User",
    define: { name: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false, tableName: "users" },
    relationships: [
      { type: "hasMany", model: "Membership", name: "memberships", options: { foreignKey: "userId" } },
    ],
  });
  await db.addDefinition({
    name: "Group",
    define: { name: { type: Sequelize.STRING, allowNull: false } },
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

async function seedGroupManager(db: Orm) {
  const alice = await db.models.User.create({ name: "Alice" });
  const bob = await db.models.User.create({ name: "Bob" });
  const charlie = await db.models.User.create({ name: "Charlie" });
  const eng = await db.models.Group.create({ name: "Engineering" });
  const mkt = await db.models.Group.create({ name: "Marketing" });
  await db.models.Membership.bulkCreate([
    { userId: alice.id, groupId: eng.id, role: "manager" },
    { userId: bob.id, groupId: eng.id, role: "member" },
    { userId: charlie.id, groupId: mkt.id, role: "manager" },
  ]);
  return { alice, bob, charlie, eng, mkt };
}

// ---------------------------------------------------------------------------
// Fixtures: self-referential Category (depth >= 2)
// ---------------------------------------------------------------------------

async function buildCategory(options: { scope?: ScopePredicate } = {}) {
  const permission = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission });
  db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
  await db.addDefinition({
    name: "Category",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      parentId: { type: Sequelize.INTEGER, allowNull: true },
    },
    options: { timestamps: false, tableName: "categories" },
    relationships: [
      { type: "hasMany", model: "Category", name: "children", options: { foreignKey: "parentId" } },
      { type: "belongsTo", model: "Category", name: "parent", options: { foreignKey: "parentId" } },
    ],
  });
  await db.initialise();
  await db.sync();
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures: belongsToMany with registered through model (UserTag / TagAssign)
// ---------------------------------------------------------------------------

async function buildBtmThrough(options: { scope?: ScopePredicate } = {}) {
  const permission = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission });
  db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
  await db.addDefinition({
    name: "Item",
    define: { title: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false, tableName: "items" },
    relationships: [
      {
        type: "belongsToMany", model: "Tag", name: "tags",
        options: { through: { model: "ItemTag" }, foreignKey: "itemId", otherKey: "tagId" },
      },
    ],
  });
  await db.addDefinition({
    name: "Tag",
    define: { label: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false, tableName: "tags" },
    relationships: [
      {
        type: "belongsToMany", model: "Item", name: "items",
        options: { through: { model: "ItemTag" }, foreignKey: "tagId", otherKey: "itemId" },
      },
    ],
  });
  // The registered through model — this makes `Association.throughModel = true`.
  await db.addDefinition({
    name: "ItemTag",
    define: {
      itemId: { type: Sequelize.INTEGER, allowNull: false },
      tagId: { type: Sequelize.INTEGER, allowNull: false },
      visible: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    },
    options: { timestamps: false, tableName: "item_tags" },
    relationships: [
      { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
      { type: "belongsTo", model: "Tag", name: "tag", options: { foreignKey: "tagId" } },
    ],
  });
  await db.initialise();
  await db.sync();
  return db;
}

// ---------------------------------------------------------------------------
// hasMany: some/none/every
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: hasMany", () => {
  it("some: returns users who have at least one membership", async () => {
    const scope: ScopePredicate = () => ({ where: { memberships: { some: {} } } });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(3);
    expect(results.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("some with inner filter: returns users with a manager membership", async () => {
    const scope: ScopePredicate = () => ({ where: { memberships: { some: { role: { eq: "manager" } } } } });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(2);
    expect(results.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Charlie"]);
  });

  it("none: returns users with no memberships", async () => {
    const scope: ScopePredicate = () => ({ where: { memberships: { none: {} } } });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).name).toBe("Nobody");
  });

  it("every with inner filter: users where every membership is manager", async () => {
    const scope: ScopePredicate = () => ({ where: { memberships: { every: { role: { eq: "manager" } } } } });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    // Alice (all manager), Charlie (all manager), Nobody (vacuously true)
    expect(results.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Charlie", "Nobody"]);
  });

  it("every with empty filter is vacuously true", async () => {
    const scope: ScopePredicate = () => ({ where: { memberships: { every: {} } } });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    // every:{} = "every related row matches {}" — vacuously true for all
    expect(results.total).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// belongsTo: is/isNot
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: belongsTo", () => {
  it("is: returns memberships whose user matches", async () => {
    const scope: ScopePredicate = () => ({ where: { user: { is: { name: { eq: "Alice" } } } } });
    const db = await buildGroupManager({ scope });
    const { alice } = await seedGroupManager(db);
    const results = await db.resolveFindAll("Membership", null, {}, ctx(String(alice.id)));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).userId).toBe(alice.id);
  });

  it("isNot: returns memberships whose user doesn't match", async () => {
    const scope: ScopePredicate = () => ({ where: { user: { isNot: { name: { eq: "Alice" } } } } });
    const db = await buildGroupManager({ scope });
    const { bob, charlie } = await seedGroupManager(db);
    const results = await db.resolveFindAll("Membership", null, {}, ctx("any"));
    expect(results.total).toBe(2);
    expect(results.models.map((r: AnyRow) => r.userId).sort()).toEqual([bob.id, charlie.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Self-referential model at depth >= 2 (issue #1)
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: self-referential depth >= 2", () => {
  it("children.children.some — unique aliases prevent ambiguity", async () => {
    // Category tree: Root -> Mid -> Leaf
    // Scope: categories that have a child that itself has a child.
    const scope: ScopePredicate = () => ({
      where: { children: { some: { children: { some: {} } } } },
    });
    const db = await buildCategory({ scope });
    const root = await db.models.Category.create({ name: "Root" });
    const mid = await db.models.Category.create({ name: "Mid", parentId: root.id });
    await db.models.Category.create({ name: "Leaf", parentId: mid.id });
    await db.models.Category.create({ name: "Orphan" });

    const results = await db.resolveFindAll("Category", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).name).toBe("Root");
  });

  it("parent.parent.is — belongsTo self-reference at depth 2", async () => {
    const scope: ScopePredicate = () => ({
      where: { parent: { is: { parent: { is: { name: { eq: "Root" } } } } } },
    });
    const db = await buildCategory({ scope });
    const root = await db.models.Category.create({ name: "Root" });
    const mid = await db.models.Category.create({ name: "Mid", parentId: root.id });
    await db.models.Category.create({ name: "Leaf", parentId: mid.id });

    const results = await db.resolveFindAll("Category", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).name).toBe("Leaf");
  });
});

// ---------------------------------------------------------------------------
// Nesting: quantifiers inside quantifiers
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: nesting", () => {
  it("nested quantifiers: users in a group that has a manager", async () => {
    const scope: ScopePredicate = () => ({
      where: {
        memberships: { some: { group: { is: { memberships: { some: { role: { eq: "manager" } } } } } } },
      },
    });
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    const results = await db.resolveFindAll("User", null, {}, ctx("any"));
    expect(results.total).toBe(3);
    expect(results.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("RFC §7 group-manager scope: users I manage", async () => {
    const scope: ScopePredicate = (_defName, _op, _opts, context) => {
      const userId = (context as { user: { id: string } }).user.id;
      return {
        where: {
          or: [
            { id: { eq: userId } },
            { memberships: { some: { group: { is: { memberships: { some: { userId: { eq: userId }, role: { eq: "manager" } } } } } } } },
          ],
        },
      };
    };
    const db = await buildGroupManager({ scope });
    const { alice, bob } = await seedGroupManager(db);

    const aliceResults = await db.resolveFindAll("User", null, {}, ctx(String(alice.id)));
    expect(aliceResults.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Bob"]);

    const bobResults = await db.resolveFindAll("User", null, {}, ctx(String(bob.id)));
    expect(bobResults.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Bob"]);
  });
});

// ---------------------------------------------------------------------------
// belongsToMany with and without registered through model (issue #4)
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: belongsToMany", () => {
  it("some: items with at least one tag (plain btm, implicit join)", async () => {
    // Plain btm (no registered through model) — implicit join table.
    const scope: ScopePredicate = (defName) => {
      if (defName !== "Item") return undefined;
      return { where: { tags: { some: {} } } };
    };
    const db = await buildBtmThrough({ scope });
    const item1 = await db.models.Item.create({ title: "Tagged" });
    const tag1 = await db.models.Tag.create({ label: "important" });
    await db.models.ItemTag.create({ itemId: item1.id, tagId: tag1.id });
    await db.models.Item.create({ title: "Untagged" });

    const results = await db.resolveFindAll("Item", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).title).toBe("Tagged");
  });

  it("none: items with no tags", async () => {
    const scope: ScopePredicate = (defName) => {
      if (defName !== "Item") return undefined;
      return { where: { tags: { none: {} } } };
    };
    const db = await buildBtmThrough({ scope });
    const item1 = await db.models.Item.create({ title: "Tagged" });
    const tag1 = await db.models.Tag.create({ label: "important" });
    await db.models.ItemTag.create({ itemId: item1.id, tagId: tag1.id });
    await db.models.Item.create({ title: "Untagged" });

    const results = await db.resolveFindAll("Item", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).title).toBe("Untagged");
  });

  it("some with inner filter on btm target", async () => {
    const scope: ScopePredicate = (defName) => {
      if (defName !== "Item") return undefined;
      return { where: { tags: { some: { label: { eq: "important" } } } } };
    };
    const db = await buildBtmThrough({ scope });
    const item1 = await db.models.Item.create({ title: "Important" });
    const item2 = await db.models.Item.create({ title: "Trivial" });
    const tagImp = await db.models.Tag.create({ label: "important" });
    const tagTriv = await db.models.Tag.create({ label: "trivial" });
    await db.models.ItemTag.create({ itemId: item1.id, tagId: tagImp.id });
    await db.models.ItemTag.create({ itemId: item2.id, tagId: tagTriv.id });

    const results = await db.resolveFindAll("Item", null, {}, ctx("any"));
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).title).toBe("Important");
  });

  it("through model scope hides links: a hidden link does not satisfy some", async () => {
    // The through model's read scope hides invisible links.
    const scope: ScopePredicate = (defName) => {
      if (defName === "Item") return { where: { tags: { some: {} } } };
      if (defName === "ItemTag") return { where: { visible: { eq: true } } };
      return undefined;
    };
    const db = await buildBtmThrough({ scope });
    const item1 = await db.models.Item.create({ title: "VisiblyTagged" });
    const item2 = await db.models.Item.create({ title: "HiddenTag" });
    const tag = await db.models.Tag.create({ label: "t" });
    await db.models.ItemTag.create({ itemId: item1.id, tagId: tag.id, visible: true });
    await db.models.ItemTag.create({ itemId: item2.id, tagId: tag.id, visible: false });

    const results = await db.resolveFindAll("Item", null, {}, ctx("any"));
    // Only item1 has a visible link; item2's link is hidden by the through scope.
    expect(results.total).toBe(1);
    expect((results.models[0] as AnyRow).title).toBe("VisiblyTagged");
  });

  it("every:{} on btm is vacuously true", async () => {
    const scope: ScopePredicate = (defName) => {
      if (defName !== "Item") return undefined;
      return { where: { tags: { every: {} } } };
    };
    const db = await buildBtmThrough({ scope });
    await db.models.Item.create({ title: "NoTags" });
    const results = await db.resolveFindAll("Item", null, {}, ctx("any"));
    expect(results.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter check
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: cross-adapter rejection", () => {
  it("throws ScopeConfigurationError for a quantifier across adapters", async () => {
    const scope: ScopePredicate = () => ({ where: { files: { some: {} } } });
    const db = new Database({ permission: { scope } });
    db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
    db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite2");
    await db.addDefinition({
      name: "Vault",
      define: { title: { type: Sequelize.STRING, allowNull: true } },
      options: { timestamps: false, tableName: "vaults" },
      relationships: [{ type: "hasMany", model: "File", name: "files", options: { foreignKey: "vaultId" } }],
    }, "sqlite");
    await db.addDefinition({
      name: "File",
      define: { name: { type: Sequelize.STRING, allowNull: false }, vaultId: { type: Sequelize.INTEGER, allowNull: true } },
      options: { timestamps: false, tableName: "files" },
    }, "sqlite2");
    await db.initialise();
    await db.sync();

    await expect(db.resolveFindAll("Vault", null, {}, ctx("any"))).rejects.toThrow(ScopeConfigurationError);
    await expect(db.resolveFindAll("Vault", null, {}, ctx("any"))).rejects.toThrow("different adapter");
  });
});

// ---------------------------------------------------------------------------
// Via sugar resolution
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: via sugar resolution", () => {
  it("resolves via path into proper quantifier nesting", async () => {
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
    const results = await db.resolveFindAll("User", null, {}, ctx(String(alice.id)));
    expect(results.models.map((r: AnyRow) => r.name as string).sort()).toEqual(["Alice", "Bob"]);
  });
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

describe("ormize - scope quantifiers: write path", () => {
  it("update with quantifier scope narrows the write", async () => {
    const scope: ScopePredicate = (defName) => {
      if (defName !== "User") return undefined;
      return { where: { memberships: { some: {} } } };
    };
    const db = await buildGroupManager({ scope });
    await seedGroupManager(db);
    await db.models.User.create({ name: "Nobody" });

    await db.processUpdate("User", null, { input: { name: "Updated" }, where: {} }, ctx("admin"));
    const all = (await db.models.User.findAll({})) as AnyRow[];
    expect(all.filter((r: AnyRow) => r.name === "Updated")).toHaveLength(3);
    expect(all.filter((r: AnyRow) => r.name === "Nobody")).toHaveLength(1);
  });
});
