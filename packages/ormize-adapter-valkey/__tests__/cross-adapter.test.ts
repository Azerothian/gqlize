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
});

describe("cross-adapter relationships — ormize API", () => {
  it("exposes an accessor on the Sequelize source instance", async () => {
    const { orm } = await build("xa-api1");
    const [item] = await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    const [file] = await orm.processCreate("File", null, { input: { name: "f1", itemId: item.id } }, {}, undefined);
    expect((await file.getItem()).label).toBe("a");
  });
});
