import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: any;

// `Item` lives on Valkey and `File` on SQLite, related in both directions: the
// belongsTo crosses SQLite -> Valkey, the hasMany crosses Valkey -> SQLite.
async function build(prefix: string) {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition({
    name: "Item",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      label: { type: DataTypes.String, index: true },
    },
    options: {},
    relationships: [
      { type: "hasMany", model: "File", name: "files", options: { foreignKey: "itemId" } },
    ],
  }, "valkey");
  await orm.addDefinition({
    name: "File",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      size: { type: Sequelize.INTEGER, allowNull: true },
      // The join key of a cross-adapter relationship is an ordinary column the
      // model declares itself — no adapter can add it, since the association it
      // belongs to spans two of them.
      itemId: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: false },
    relationships: [
      { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
    ],
  }, "sqlite");
  await orm.initialise();
  await orm.sync();
  const schema = await createSchema(orm);
  return { orm, schema };
}

const q = async (schema: any, source: string) => {
  const r: any = await graphql({ schema, source });
  expect(r.errors).toBeUndefined();
  return r.data;
};

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("cross-adapter relationships — schema", () => {
  it("builds a schema when a Sequelize model belongsTo a Valkey model", async () => {
    const { schema } = await build("xa-schema");
    expect(schema.getType("File")).toBeDefined();
    expect(schema.getType("Item")).toBeDefined();
  });

  it("exposes the relationship field on both sides", async () => {
    const { schema } = await build("xa-fields");
    expect(Object.keys((schema.getType("File") as any).getFields())).toContain("item");
    expect(Object.keys((schema.getType("Item") as any).getFields())).toContain("files");
  });

  it("reports the relationship as cross-adapter on both sides", async () => {
    const { orm } = await build("xa-flag");
    expect(orm.getAssociations("File").item).toMatchObject({
      target: "Item", source: "File", associationType: "belongsTo",
      foreignKey: "itemId", targetKey: "id", crossAdapter: true,
    });
    expect(orm.getAssociations("Item").files).toMatchObject({
      target: "File", source: "Item", associationType: "hasMany",
      foreignKey: "itemId", sourceKey: "id", crossAdapter: true,
    });
  });

  it("omits cross-adapter relations from the include (JOIN) argument", async () => {
    const { schema } = await build("xa-include");
    // Neither a SQL JOIN nor a single Valkey round trip can span two datastores,
    // so neither side may offer the relation as an eager-include target.
    for (const [typeName, relName] of [["GQLTFileInclude", "item"], ["GQLTItemInclude", "files"]]) {
      const includeType: any = schema.getType(typeName);
      if (includeType?.getFields) {
        expect(Object.keys(includeType.getFields())).not.toContain(relName);
      }
    }
  });
});

describe("cross-adapter relationships — queries", () => {
  const seed = async (orm: any) => {
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    const [other] = await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    for (const [name, size] of [["f1", 10], ["f2", 20], ["f3", 30]]) {
      await orm.processCreate("File", null, { input: { name, size, itemId: item.id } }, {}, undefined);
    }
    await orm.processCreate("File", null, { input: { name: "other", size: 99, itemId: other.id } }, {}, undefined);
    return { item, other };
  };

  it("resolves Sequelize -> Valkey belongsTo", async () => {
    const { orm, schema } = await build("xa-q1");
    await seed(orm);
    const d = await q(schema, `{ models { File(where: { name: { eq: "f1" } }) { edges { node { name item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item.label).toBe("a");
  });

  it("resolves Valkey -> Sequelize hasMany", async () => {
    const { orm, schema } = await build("xa-q2");
    await seed(orm);
    const d = await q(schema, `{ models { Item(where: { label: { eq: "a" } }) { edges { node { files { total edges { node { name } } } } } } } }`);
    const files = d.models.Item.edges[0].node.files;
    expect(files.total).toBe(3);
    expect(files.edges.map((e: any) => e.node.name).sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("scopes the hasMany to its own parent", async () => {
    const { orm, schema } = await build("xa-q3");
    await seed(orm);
    const d = await q(schema, `{ models { Item(where: { label: { eq: "b" } }) { edges { node { files { edges { node { name } } } } } } } }`);
    expect(d.models.Item.edges[0].node.files.edges.map((e: any) => e.node.name)).toEqual(["other"]);
  });

  it("applies `where` on top of the join key", async () => {
    const { orm, schema } = await build("xa-q4");
    await seed(orm);
    const d = await q(schema, `{ models { Item(where: { label: { eq: "a" } }) { edges { node { files(where: { size: { gte: 20 } }) { total edges { node { name } } } } } } } }`);
    const files = d.models.Item.edges[0].node.files;
    expect(files.edges.map((e: any) => e.node.name).sort()).toEqual(["f2", "f3"]);
    expect(files.total).toBe(2);
  });

  it("applies ordering and pagination", async () => {
    const { orm, schema } = await build("xa-q5");
    await seed(orm);
    const d = await q(schema, `{ models { Item(where: { label: { eq: "a" } }) { edges { node { files(orderBy: sizeDESC, first: 2) { total edges { node { name } } } } } } } }`);
    const files = d.models.Item.edges[0].node.files;
    expect(files.edges.map((e: any) => e.node.name)).toEqual(["f3", "f2"]);
    // `total` is the unpaginated count of the scoped set.
    expect(files.total).toBe(3);
  });

  it("counts without loading rows when only `total` is selected", async () => {
    const { orm, schema } = await build("xa-q6");
    await seed(orm);
    const d = await q(schema, `{ models { Item(where: { label: { eq: "a" } }) { edges { node { files { total } } } } } }`);
    expect(d.models.Item.edges[0].node.files.total).toBe(3);
  });

  it("returns null for a belongsTo with no foreign key set", async () => {
    const { orm, schema } = await build("xa-q7");
    await orm.processCreate("File", null, { input: { name: "orphan" } }, {}, undefined);
    const d = await q(schema, `{ models { File { edges { node { name item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item).toBeNull();
  });

  it("returns an empty connection for a hasMany with no children", async () => {
    const { orm, schema } = await build("xa-q8");
    await orm.processCreate("Item", null, { input: { label: "lonely" } }, {}, undefined);
    const d = await q(schema, `{ models { Item { edges { node { files { total edges { node { name } } } } } } } }`);
    expect(d.models.Item.edges[0].node.files).toEqual({ total: 0, edges: [] });
  });

  it("resolves the relation even when the join key is not itself selected", async () => {
    const { orm, schema } = await build("xa-q9");
    await seed(orm);
    // `itemId` is absent from the selection set; the adapter must still load it,
    // since the second query has nothing to join on otherwise.
    const d = await q(schema, `{ models { File(where: { name: { eq: "f2" } }) { edges { node { item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item.label).toBe("a");
  });

  it("round-trips both directions in one query", async () => {
    const { orm, schema } = await build("xa-q10");
    await seed(orm);
    const d = await q(schema, `{ models { File(where: { name: { eq: "f1" } }) { edges { node { name item { label files { total } } } } } } }`);
    const node = d.models.File.edges[0].node;
    expect(node.item.label).toBe("a");
    expect(node.item.files.total).toBe(3);
  });
});

// The mirror of `build()`: the hasMany parent is on SQLite and the children are
// on Valkey, so Valkey is the adapter that has to answer the scoped query.
async function buildMirror(prefix: string) {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition({
    name: "Owner",
    define: { name: { type: Sequelize.STRING } },
    options: { timestamps: false },
    relationships: [
      { type: "hasMany", model: "Tag", name: "tags", options: { foreignKey: "ownerId" } },
    ],
  }, "sqlite");
  await orm.addDefinition({
    name: "Tag",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      value: { type: DataTypes.String, index: true },
      // The join key must be indexed — Valkey never scans the keyspace.
      ownerId: { type: DataTypes.String, index: true },
    },
    options: {},
    relationships: [
      { type: "belongsTo", model: "Owner", name: "owner", options: { foreignKey: "ownerId" } },
    ],
  }, "valkey");
  await orm.initialise();
  await orm.sync();
  return { orm, schema: await createSchema(orm) };
}

describe("cross-adapter relationships — Valkey as the queried target", () => {
  it("resolves a Sequelize hasMany whose children live on Valkey", async () => {
    const { orm, schema } = await buildMirror("xa-m1");
    const [owner] = await orm.processCreate("Owner", null, { input: { name: "o1" } }, {}, undefined);
    const [other] = await orm.processCreate("Owner", null, { input: { name: "o2" } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t1", ownerId: String(owner.id) } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t2", ownerId: String(owner.id) } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t3", ownerId: String(other.id) } }, {}, undefined);

    const d = await q(schema, `{ models { Owner(where: { name: { eq: "o1" } }) { edges { node { tags { total edges { node { value } } } } } } } }`);
    const tags = d.models.Owner.edges[0].node.tags;
    expect(tags.total).toBe(2);
    expect(tags.edges.map((e: any) => e.node.value).sort()).toEqual(["t1", "t2"]);
  });

  it("resolves a Valkey belongsTo whose parent lives on Sequelize", async () => {
    const { orm, schema } = await buildMirror("xa-m2");
    const [owner] = await orm.processCreate("Owner", null, { input: { name: "o1" } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t1", ownerId: String(owner.id) } }, {}, undefined);

    const d = await q(schema, `{ models { Tag { edges { node { value owner { name } } } } } }`);
    expect(d.models.Tag.edges[0].node.owner.name).toBe("o1");
  });
});

describe("cross-adapter relationships — mutations", () => {
  it("creates a child on the other adapter through a hasMany", async () => {
    const { orm, schema } = await build("xa-mut1");
    await q(schema, `mutation { models { Item(create: { label: "a", files: { create: [{ name: "f1" }] } }) { label } } }`);
    const d = await q(schema, `{ models { Item { edges { node { files { total edges { node { name } } } } } } } }`);
    expect(d.models.Item.edges[0].node.files.edges.map((e: any) => e.node.name)).toEqual(["f1"]);
    // ...and the foreign key really landed on the SQLite row
    const files = await orm.models.File.findAll();
    expect(files).toHaveLength(1);
    expect(files[0].get("itemId")).toBeTruthy();
  });

  it("links an existing child through a hasMany `add`", async () => {
    const { orm, schema } = await build("xa-mut2");
    await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1" } }, {}, undefined);
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { add: [{ name: { eq: "f1" } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { Item { edges { node { files { edges { node { name } } } } } } } }`);
    expect(d.models.Item.edges[0].node.files.edges.map((e: any) => e.node.name)).toEqual(["f1"]);
  });

  it("unlinks a child through a hasMany `remove`", async () => {
    const { orm, schema } = await build("xa-mut3");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { remove: [{ name: { eq: "f1" } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { Item { edges { node { files { total } } } } } }`);
    expect(d.models.Item.edges[0].node.files.total).toBe(0);
  });

  it("replaces the whole collection through a hasMany `set`", async () => {
    const { orm, schema } = await build("xa-mut5");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f2" } }, {}, undefined);
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { set: [{ name: { eq: "f2" } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { Item { edges { node { files { edges { node { name } } } } } } } }`);
    expect(d.models.Item.edges[0].node.files.edges.map((e: any) => e.node.name)).toEqual(["f2"]);
  });

  it("points a belongsTo at an existing parent on the other adapter", async () => {
    const { orm, schema } = await build("xa-mut4");
    await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1" } }, {}, undefined);
    await q(schema, `mutation { models { File(update: { where: { name: { eq: "f1" } }, input: { item: { set: { label: { eq: "a" } } } } }) { name } } }`);
    const d = await q(schema, `{ models { File { edges { node { item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item.label).toBe("a");
  });

  it("clears a belongsTo through `remove`", async () => {
    const { orm, schema } = await build("xa-mut6");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await q(schema, `mutation { models { File(update: { where: { name: { eq: "f1" } }, input: { item: { remove: true } } }) { name } } }`);
    const d = await q(schema, `{ models { File { edges { node { item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item).toBeNull();
  });

  it("updates a child on the other adapter through a hasMany `update`", async () => {
    const { orm, schema } = await build("xa-mut7");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", size: 1, itemId: item.id } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f2", size: 1 } }, {}, undefined);
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { update: [{ where: { name: { eq: "f1" } }, input: { size: 99 } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { File { edges { node { name size } } } } }`);
    const sizes = Object.fromEntries(d.models.File.edges.map((e: any) => [e.node.name, e.node.size]));
    // ...and the unrelated file is left alone: the update is scoped to the parent.
    expect(sizes).toEqual({ f1: 99, f2: 1 });
  });

  it("deletes a child on the other adapter through a hasMany `delete`", async () => {
    const { orm, schema } = await build("xa-mut8");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f2", itemId: item.id } }, {}, undefined);
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { delete: [{ name: { eq: "f1" } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { File { edges { node { name } } } } }`);
    expect(d.models.File.edges.map((e: any) => e.node.name)).toEqual(["f2"]);
  });

  it("runs a nested mutation on a child through `select` without modifying it", async () => {
    const { orm, schema } = await build("xa-mut9");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", size: 1, itemId: item.id } }, {}, undefined);
    // `size` is ignored — `select` only runs the relationship mutations in `input`,
    // here unlinking the child from the very parent that selected it.
    await q(schema, `mutation { models { Item(update: { where: { label: { eq: "a" } }, input: { files: { select: [{ where: { name: { eq: "f1" } }, input: { size: 42, item: { remove: true } } }] } } }) { label } } }`);
    const d = await q(schema, `{ models { File { edges { node { name size item { label } } } } } }`);
    expect(d.models.File.edges[0].node).toMatchObject({ name: "f1", size: 1, item: null });
  });

  it("creates a parent on the other adapter through a belongsTo `create`", async () => {
    const { schema } = await build("xa-mut10");
    await q(schema, `mutation { models { File(create: { name: "f1", size: 1, item: { create: { label: "a" } } }) { name } } }`);
    const d = await q(schema, `{ models { File { edges { node { name item { label } } } } } }`);
    expect(d.models.File.edges[0].node.item.label).toBe("a");
  });

  it("updates the parent on the other adapter through a belongsTo `update`", async () => {
    const { orm, schema } = await build("xa-mut11");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await q(schema, `mutation { models { File(update: { where: { name: { eq: "f1" } }, input: { item: { update: { where: { label: { eq: "a" } }, input: { label: "a2" } } } } }) { name } } }`);
    const d = await q(schema, `{ models { Item { edges { node { label } } } } }`);
    expect(d.models.Item.edges.map((e: any) => e.node.label).sort()).toEqual(["a2", "b"]);
  });

  it("deletes the parent on the other adapter through a belongsTo `delete`", async () => {
    const { orm, schema } = await build("xa-mut12");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    await q(schema, `mutation { models { File(update: { where: { name: { eq: "f1" } }, input: { item: { delete: { label: { eq: "a" } } } } }) { name } } }`);
    const d = await q(schema, `{ models { Item { edges { node { label } } } } }`);
    expect(d.models.Item.edges.map((e: any) => e.node.label)).toEqual(["b"]);
  });
});

// The same mutations with the write landing on Valkey rather than SQLite: a
// cross-adapter write goes through `adapter.update`, and a Valkey record is a
// plain object where a Sequelize one is a class instance.
describe("cross-adapter relationships — mutations with Valkey as the target", () => {
  it("creates a child on Valkey through a hasMany", async () => {
    const { schema } = await buildMirror("xa-mm1");
    await q(schema, `mutation { models { Owner(create: { name: "o1", tags: { create: [{ value: "t1" }] } }) { name } } }`);
    const d = await q(schema, `{ models { Owner { edges { node { tags { edges { node { value } } } } } } } }`);
    expect(d.models.Owner.edges[0].node.tags.edges.map((e: any) => e.node.value)).toEqual(["t1"]);
  });

  it("links, updates, unlinks and deletes a Valkey child from a SQLite parent", async () => {
    const { orm, schema } = await buildMirror("xa-mm2");
    await orm.processCreate("Owner", null, { input: { name: "o1" } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t1" } }, {}, undefined);
    const tags = async () => (await q(schema, `{ models { Owner { edges { node { tags { edges { node { value } } } } } } } }`))
      .models.Owner.edges[0].node.tags.edges.map((e: any) => e.node.value);

    const mutate = (input: string) => q(schema, `mutation { models { Owner(update: { where: { name: { eq: "o1" } }, input: { tags: ${input} } }) { name } } }`);
    await mutate(`{ add: [{ value: { eq: "t1" } }] }`);
    expect(await tags()).toEqual(["t1"]);
    await mutate(`{ update: [{ where: { value: { eq: "t1" } }, input: { value: "t1b" } }] }`);
    expect(await tags()).toEqual(["t1b"]);
    await mutate(`{ remove: [{ value: { eq: "t1b" } }] }`);
    expect(await tags()).toEqual([]);
    await mutate(`{ set: [{ value: { eq: "t1b" } }] }`);
    expect(await tags()).toEqual(["t1b"]);
    await mutate(`{ delete: [{ value: { eq: "t1b" } }] }`);
    expect(await tags()).toEqual([]);
    expect(await orm.getModelAdapter("Tag").findAll("Tag", {})).toHaveLength(0);
  });

  it("points a Valkey belongsTo at a SQLite parent and clears it again", async () => {
    const { orm, schema } = await buildMirror("xa-mm3");
    await orm.processCreate("Owner", null, { input: { name: "o1" } }, {}, undefined);
    await orm.processCreate("Tag", null, { input: { value: "t1" } }, {}, undefined);
    const owner = async () => (await q(schema, `{ models { Tag { edges { node { owner { name } } } } } }`))
      .models.Tag.edges[0].node.owner;

    await q(schema, `mutation { models { Tag(update: { where: { value: { eq: "t1" } }, input: { owner: { set: { name: { eq: "o1" } } } } }) { value } } }`);
    expect(await owner()).toEqual({ name: "o1" });
    await q(schema, `mutation { models { Tag(update: { where: { value: { eq: "t1" } }, input: { owner: { remove: true } } }) { value } } }`);
    expect(await owner()).toBeNull();
  });
});

// The third relationship type: like hasMany the key lives on the target, but only
// one row comes back.
async function buildHasOne(prefix: string) {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition({
    name: "Account",
    define: { email: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false },
    relationships: [
      { type: "hasOne", model: "Profile", name: "profile", options: { foreignKey: "accountId" } },
    ],
  }, "sqlite");
  await orm.addDefinition({
    name: "Profile",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      nickname: { type: DataTypes.String, index: true },
      accountId: { type: DataTypes.String, index: true },
    },
    options: {},
    relationships: [
      { type: "belongsTo", model: "Account", name: "account", options: { foreignKey: "accountId" } },
    ],
  }, "valkey");
  await orm.initialise();
  await orm.sync();
  return { orm, schema: await createSchema(orm) };
}

describe("cross-adapter relationships — hasOne", () => {
  it("resolves a hasOne whose target lives on the other adapter", async () => {
    const { orm, schema } = await buildHasOne("xa-h1");
    const [account] = await orm.processCreate("Account", null, { input: { email: "a@b.c" } }, {}, undefined);
    await orm.processCreate("Profile", null, { input: { nickname: "nick", accountId: `${account.id}` } }, {}, undefined);
    const d = await q(schema, `{ models { Account { edges { node { email profile { nickname } } } } } }`);
    expect(d.models.Account.edges[0].node).toEqual({ email: "a@b.c", profile: { nickname: "nick" } });
  });

  it("returns null when nothing points back at the source", async () => {
    const { orm, schema } = await buildHasOne("xa-h2");
    await orm.processCreate("Account", null, { input: { email: "a@b.c" } }, {}, undefined);
    const d = await q(schema, `{ models { Account { edges { node { profile { nickname } } } } } }`);
    expect(d.models.Account.edges[0].node.profile).toBeNull();
  });

  it("creates, replaces and clears the target through the hasOne", async () => {
    const { orm, schema } = await buildHasOne("xa-h3");
    await orm.processCreate("Account", null, { input: { email: "a@b.c" } }, {}, undefined);
    await orm.processCreate("Profile", null, { input: { nickname: "other" } }, {}, undefined);
    const profile = async () => (await q(schema, `{ models { Account { edges { node { profile { nickname } } } } } }`))
      .models.Account.edges[0].node.profile;
    const mutate = (input: string) => q(schema, `mutation { models { Account(update: { where: { email: { eq: "a@b.c" } }, input: { profile: ${input} } }) { email } } }`);

    await mutate(`{ create: { nickname: "nick" } }`);
    expect(await profile()).toEqual({ nickname: "nick" });
    // Replacing a hasOne unlinks whoever held the slot before.
    await mutate(`{ set: { nickname: { eq: "other" } } }`);
    expect(await profile()).toEqual({ nickname: "other" });
    const orphaned = await orm.getModelAdapter("Profile").findAll("Profile", { where: { nickname: { eq: "nick" } } });
    expect(orphaned[0].accountId).toBeNull();
    await mutate(`{ remove: true }`);
    expect(await profile()).toBeNull();
  });

});

// belongsToMany is the only type whose link is a record rather than a column, so
// the join has to physically live in one store or the other. Which one is the
// caller's choice, expressed by which adapter the through model is registered on
// — both are exercised below.
async function buildBtm(prefix: string, throughOn: "valkey" | "sqlite") {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition({
    name: "Student",
    define: {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      name: { type: Sequelize.STRING, allowNull: false },
    },
    options: { timestamps: false },
    // `otherKey` is deliberately omitted here: it is derived from the reciprocal
    // belongsToMany declared on `Course` below.
    relationships: [
      { type: "belongsToMany", model: "Course", name: "courses", options: { through: "Enrolment", foreignKey: "studentId" } },
    ],
  }, "sqlite");
  await orm.addDefinition({
    name: "Course",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      title: { type: DataTypes.String, index: true },
    },
    options: {},
    relationships: [
      { type: "belongsToMany", model: "Student", name: "students", options: { through: "Enrolment", foreignKey: "courseId", otherKey: "studentId" } },
    ],
  }, "valkey");
  await orm.addDefinition(throughOn === "valkey" ? {
    name: "Enrolment",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      // Both join keys have to be indexed — Valkey answers every `where` from an
      // index and never scans the keyspace.
      studentId: { type: DataTypes.String, index: true },
      courseId: { type: DataTypes.String, index: true },
      grade: { type: DataTypes.String },
    },
    options: {},
    relationships: [],
  } : {
    name: "Enrolment",
    define: {
      studentId: { type: Sequelize.STRING, allowNull: true },
      courseId: { type: Sequelize.STRING, allowNull: true },
      grade: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: false },
    relationships: [],
  }, throughOn);
  await orm.initialise();
  await orm.sync();
  return { orm, schema: await createSchema(orm) };
}

describe.each(["sqlite", "valkey"] as const)("cross-adapter relationships — belongsToMany (join on %s)", (throughOn) => {
  const build = async (prefix: string) => {
    const built = await buildBtm(`${prefix}-${throughOn}`, throughOn);
    for (const name of ["ann", "bob"]) {
      await built.orm.processCreate("Student", null, { input: { name } }, {}, undefined);
    }
    for (const title of ["maths", "art", "music"]) {
      await built.orm.processCreate("Course", null, { input: { title } }, {}, undefined);
    }
    return built;
  };
  // Every mutation below drives the SQLite side; the queries read both directions.
  const mutate = (schema: any, body: string) => q(schema, `mutation { models { Student(update: { where: { name: { eq: "ann" } }, input: { courses: ${body} } }) { name } } }`);
  const coursesOf = async (schema: any, student = "ann", args = "") => (await q(schema, `{ models { Student(where: { name: { eq: "${student}" } }) { edges { node { courses${args} { total edges { node { title } } } } } } } }`))
    .models.Student.edges[0].node.courses;
  const enrolments = async (orm: any) => orm.getModelAdapter("Enrolment").findAll("Enrolment", {});

  it("flags the relationship as cross-adapter and carries its join model", async () => {
    const { orm } = await build("xa-btm-s");
    expect(orm.getAssociations("Student").courses).toMatchObject({
      associationType: "belongsToMany", crossAdapter: true, target: "Course",
      through: "Enrolment", foreignKey: "studentId", otherKey: "courseId",
    });
    expect(orm.getAssociations("Course").students).toMatchObject({
      crossAdapter: true, through: "Enrolment", foreignKey: "courseId", otherKey: "studentId",
    });
  });

  it("resolves through the join model in both directions", async () => {
    const { orm, schema } = await build("xa-btm-q");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }, { where: { title: { eq: "art" } } }] }`);

    const courses = await coursesOf(schema);
    expect(courses.total).toBe(2);
    expect(courses.edges.map((e: any) => e.node.title).sort()).toEqual(["art", "maths"]);
    // The mirror direction reads the same join rows by the other key.
    const d = await q(schema, `{ models { Course(where: { title: { eq: "maths" } }) { edges { node { students { edges { node { name } } } } } } } }`);
    expect(d.models.Course.edges[0].node.students.edges.map((e: any) => e.node.name)).toEqual(["ann"]);
    expect(await enrolments(orm)).toHaveLength(2);
  });

  it("writes and then updates join-row attributes through `add`", async () => {
    const { orm, schema } = await build("xa-btm-t");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } }, through: { grade: "A" } }] }`);
    expect((await enrolments(orm)).map((e: any) => e.grade)).toEqual(["A"]);
    // Adding an already-linked target updates the existing row rather than
    // creating a second one.
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } }, through: { grade: "B" } }] }`);
    const rows = await enrolments(orm);
    expect(rows).toHaveLength(1);
    expect(rows[0].grade).toBe("B");
  });

  it("keeps each source's links to itself", async () => {
    const { orm, schema } = await build("xa-btm-o");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }] }`);
    await q(schema, `mutation { models { Student(update: { where: { name: { eq: "bob" } }, input: { courses: { add: [{ where: { title: { eq: "art" } } }] } } }) { name } } }`);
    expect((await coursesOf(schema, "ann")).edges.map((e: any) => e.node.title)).toEqual(["maths"]);
    expect((await coursesOf(schema, "bob")).edges.map((e: any) => e.node.title)).toEqual(["art"]);
    expect(await enrolments(orm)).toHaveLength(2);
  });

  it("removes one link and leaves the rest", async () => {
    const { orm, schema } = await build("xa-btm-r");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }, { where: { title: { eq: "art" } } }] }`);
    await mutate(schema, `{ remove: [{ title: { eq: "maths" } }] }`);
    expect((await coursesOf(schema)).edges.map((e: any) => e.node.title)).toEqual(["art"]);
    // The link is gone but the target is not.
    expect(await enrolments(orm)).toHaveLength(1);
    const d = await q(schema, `{ models { Course(where: { title: { eq: "maths" } }) { total } } }`);
    expect(d.models.Course.total).toBe(1);
  });

  it("replaces the whole set", async () => {
    const { schema } = await build("xa-btm-e");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }, { where: { title: { eq: "art" } } }] }`);
    await mutate(schema, `{ set: [{ where: { title: { eq: "music" } }, through: { grade: "C" } }] }`);
    expect((await coursesOf(schema)).edges.map((e: any) => e.node.title)).toEqual(["music"]);
  });

  it("creates the target on the other adapter and links it", async () => {
    const { schema } = await build("xa-btm-c");
    await mutate(schema, `{ create: [{ title: "physics" }] }`);
    expect((await coursesOf(schema)).edges.map((e: any) => e.node.title)).toEqual(["physics"]);
  });

  it("updates and deletes targets through the relationship", async () => {
    const { schema } = await build("xa-btm-u");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }, { where: { title: { eq: "art" } } }] }`);
    await mutate(schema, `{ update: [{ where: { title: { eq: "art" } }, input: { title: "drawing" } }] }`);
    expect((await coursesOf(schema)).edges.map((e: any) => e.node.title).sort()).toEqual(["drawing", "maths"]);
    await mutate(schema, `{ delete: [{ title: { eq: "maths" } }] }`);
    expect((await coursesOf(schema)).edges.map((e: any) => e.node.title)).toEqual(["drawing"]);
  });

  it("applies `where`, ordering and pagination on top of the join", async () => {
    const { schema } = await build("xa-btm-w");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }, { where: { title: { eq: "art" } } }, { where: { title: { eq: "music" } } }] }`);
    expect((await coursesOf(schema, "ann", `(where: { title: { eq: "art" } })`)).edges.map((e: any) => e.node.title)).toEqual(["art"]);
    const page = await coursesOf(schema, "ann", "(orderBy: titleASC, first: 2)");
    expect(page.edges.map((e: any) => e.node.title)).toEqual(["art", "maths"]);
    // `total` is the unpaginated count of the linked set.
    expect(page.total).toBe(3);
  });

  it("returns an empty connection when nothing is linked", async () => {
    const { schema } = await build("xa-btm-n");
    expect(await coursesOf(schema)).toEqual({ total: 0, edges: [] });
  });

  it("exposes accessors on the source instance", async () => {
    const { orm, schema } = await build("xa-btm-a");
    await mutate(schema, `{ add: [{ where: { title: { eq: "maths" } } }] }`);
    const [student] = await orm.getModelAdapter("Student").findAll("Student", { where: { name: "ann" } });
    expect((await student.getCourses()).map((c: any) => c.title)).toEqual(["maths"]);
    expect(await student.countCourses()).toBe(1);
  });
});

// A through model nobody registered is generated on the first registered adapter
// — here Valkey, which is registered first below.
describe("cross-adapter relationships — a generated join model", () => {
  const buildWith = async (prefix: string, options: any, reciprocal?: any) => {
    const orm: any = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
    orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await orm.addDefinition({
      name: "Left",
      define: { name: { type: Sequelize.STRING, allowNull: false } },
      options: { timestamps: false },
      relationships: [{ type: "belongsToMany", model: "Right", name: "rights", options }],
    }, "sqlite");
    await orm.addDefinition({
      name: "Right",
      define: { id: { type: DataTypes.UUID, primaryKey: true }, name: { type: DataTypes.String, index: true } },
      options: {},
      relationships: reciprocal ? [{ type: "belongsToMany", model: "Left", name: "lefts", options: reciprocal }] : [],
    }, "valkey");
    await orm.initialise();
    await orm.sync();
    return { orm, schema: await createSchema(orm) };
  };
  const link = async (schema: any) => {
    await q(schema, `mutation { models { Left(create: { name: "l1" }) { name } } }`);
    await q(schema, `mutation { models { Right(create: { name: "r1" }) { name } } }`);
    await q(schema, `mutation { models { Left(update: { where: { name: { eq: "l1" } }, input: { rights: { add: [{ where: { name: { eq: "r1" } } }] } } }) { name } } }`);
    return (await q(schema, `{ models { Left { edges { node { rights { edges { node { name } } } } } } } }`))
      .models.Left.edges[0].node.rights.edges.map((e: any) => e.node.name);
  };

  it("generates the named through model on the first registered adapter", async () => {
    const { orm, schema } = await buildWith("xa-btm-g1", { through: "LeftRight", foreignKey: "leftId", otherKey: "rightId" });
    expect(orm.defsAdapters.LeftRight).toBe("valkey");
    expect(await link(schema)).toEqual(["r1"]);
    expect(await orm.getModelAdapter("LeftRight").findAll("LeftRight", {})).toHaveLength(1);
  });

  it("names an unnamed through model after the pair, the same way from either side", async () => {
    const { orm, schema } = await buildWith("xa-btm-g2",
      { foreignKey: "leftId", otherKey: "rightId" },
      { foreignKey: "rightId", otherKey: "leftId" });
    // Sorted, so both sides land on the same model however they are wired.
    expect(orm.getAssociations("Left").rights.through).toBe("LeftRight");
    expect(orm.getAssociations("Right").lefts.through).toBe("LeftRight");
    expect(await link(schema)).toEqual(["r1"]);
    const d = await q(schema, `{ models { Right { edges { node { lefts { edges { node { name } } } } } } } }`);
    expect(d.models.Right.edges[0].node.lefts.edges.map((e: any) => e.node.name)).toEqual(["l1"]);
  });

  it("mirrors the type of each key it points at", async () => {
    const { orm } = await buildWith("xa-btm-g3", { through: "LeftRight", foreignKey: "leftId", otherKey: "rightId" });
    const fields = orm.getFields("LeftRight");
    // `Left.id` is a SQLite auto-increment integer, `Right.id` a Valkey UUID.
    expect(fields.leftId.type.type).toBe("Int");
    expect(fields.rightId.type.type).toBe("UUID");
  });

  it("leaves an explicitly registered through model alone", async () => {
    const orm: any = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "xa-btm-g4" }, client), "valkey");
    orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await orm.addDefinition({
      name: "Left",
      define: { name: { type: Sequelize.STRING, allowNull: false } },
      options: { timestamps: false },
      relationships: [{ type: "belongsToMany", model: "Right", name: "rights", options: { through: "LeftRight", foreignKey: "leftId", otherKey: "rightId" } }],
    }, "sqlite");
    await orm.addDefinition({
      name: "Right",
      define: { id: { type: DataTypes.UUID, primaryKey: true }, name: { type: DataTypes.String, index: true } },
      options: {},
      relationships: [],
    }, "valkey");
    await orm.addDefinition({
      name: "LeftRight",
      define: {
        leftId: { type: Sequelize.INTEGER, allowNull: true },
        rightId: { type: Sequelize.STRING, allowNull: true },
        note: { type: Sequelize.STRING, allowNull: true },
      },
      options: { timestamps: false },
      relationships: [],
    }, "sqlite");
    await orm.initialise();
    await orm.sync();
    const schema = await createSchema(orm);
    expect(orm.defsAdapters.LeftRight).toBe("sqlite");
    expect(await link(schema)).toEqual(["r1"]);
    // The registered columns survive — nothing was regenerated over them.
    expect(Object.keys(orm.getFields("LeftRight"))).toContain("note");
  });
});

// Soft delete lives on the SQLite side — Valkey has no paranoid mode — so this
// pair exercises `delete`/`restore` on a cross-adapter collection.
async function buildParanoid(prefix: string) {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition({
    name: "Box",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      label: { type: DataTypes.String, index: true },
    },
    options: {},
    relationships: [
      { type: "hasMany", model: "Doc", name: "docs", options: { foreignKey: "boxId" } },
    ],
  }, "valkey");
  await orm.addDefinition({
    name: "Doc",
    define: {
      title: { type: Sequelize.STRING, allowNull: false },
      boxId: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: true, paranoid: true },
    relationships: [],
  }, "sqlite");
  await orm.initialise();
  await orm.sync();
  return { orm, schema: await createSchema(orm) };
}

describe("cross-adapter relationships — soft delete", () => {
  it("soft-deletes and restores a child on the other adapter", async () => {
    const { orm, schema } = await buildParanoid("xa-p1");
    const [box] = await orm.processCreate("Box", null, { input: { label: "b1" } }, {}, undefined);
    await orm.processCreate("Doc", null, { input: { title: "d1", boxId: box.id } }, {}, undefined);
    const docs = async () => (await q(schema, `{ models { Box { edges { node { docs { total } } } } } }`))
      .models.Box.edges[0].node.docs.total;

    await q(schema, `mutation { models { Box(update: { where: { label: { eq: "b1" } }, input: { docs: { delete: [{ title: { eq: "d1" } }] } } }) { label } } }`);
    expect(await docs()).toBe(0);
    await q(schema, `mutation { models { Box(update: { where: { label: { eq: "b1" } }, input: { docs: { restore: [{ title: { eq: "d1" } }] } } }) { label } } }`);
    expect(await docs()).toBe(1);
  });
});

describe("cross-adapter relationships — ormize API", () => {
  it("exposes an accessor on the Sequelize source instance", async () => {
    const { orm } = await build("xa-api1");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    const [file] = await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    expect((await file.getItem()).label).toBe("a");
  });
});
