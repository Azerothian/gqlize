import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: any;

// One portable model set (authored with DataTypes.*) covering all four relation
// types, run against BOTH adapters:
//   Author hasOne Profile, Author hasMany Post, Post belongsTo Author,
//   Post belongsToMany Tag (through PostTag with a sortOrder column).
// A fresh definition set per test — the Sequelize adapter mutates
// `relationship.options.through.model` (string → model instance) at wiring time,
// so a shared/reused array would corrupt subsequent builds.
// No explicit primary key → both adapters synthesize an auto-increment integer
// `id` (Sequelize's default; Valkey via an INCR sequence). Foreign keys are
// auto-created by the relationships (nullable), so set/remove can unlink.
const makeDefs = () => [
  {
    name: "Author",
    define: { name: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [
      { type: "hasOne", model: "Profile", name: "profile", options: { foreignKey: "authorId" } },
      { type: "hasMany", model: "Post", name: "posts", options: { foreignKey: "authorId" } },
    ],
  },
  {
    name: "Profile",
    define: { bio: { type: DataTypes.String } },
    options: {},
    relationships: [{ type: "belongsTo", model: "Author", name: "author", options: { foreignKey: "authorId" } }],
  },
  {
    name: "Post",
    define: { title: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [
      { type: "belongsTo", model: "Author", name: "author", options: { foreignKey: "authorId" } },
      { type: "belongsToMany", model: "Tag", name: "tags", options: { through: { model: "PostTag" }, foreignKey: "postId", otherKey: "tagId" } },
    ],
  },
  {
    name: "Tag",
    define: { label: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [{ type: "belongsToMany", model: "Post", name: "posts", options: { through: { model: "PostTag" }, foreignKey: "tagId", otherKey: "postId" } }],
  },
  // Through model carrying an extra column (queryable on both adapters).
  { name: "PostTag", define: { sortOrder: { type: DataTypes.Int, allowNull: true } }, options: {} },
];

const backends = [
  { name: "sequelize", makeAdapter: () => new SequelizeAdapter({}, { dialect: "sqlite", logging: false }) },
  { name: "valkey", makeAdapter: () => new ValkeyAdapter({ prefix: "rel" }, client) },
];

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });

describe.each(backends)("$name adapter — relation types + transactions", ({ name, makeAdapter }) => {
  let orm: any;

  beforeEach(async () => {
    if (name === "valkey") await flush(client);
    orm = new Ormize();
    orm.registerAdapter(makeAdapter(), "db");
    for (const d of makeDefs()) await orm.addDefinition(d);
    await orm.initialise();
    await orm.sync();
  });

  const create = (model: string, input: any, options?: any) => orm.processCreate(model, null, { input }, {}, options).then((r: any[]) => r[0]);
  const update = (model: string, where: any, input: any, options?: any) => orm.processUpdate(model, null, { input, where }, {}, options);
  const list = (model: string, where?: any) => orm.resolveFindAll(model, null, where ? { where } : {}, {}, undefined).then((r: any) => r.models);
  const one = async (model: string, where: any) => (await list(model, where))[0];
  // Read a relationship portably via FK/join queries (avoids adapter-specific
  // resolveSingleRelationship arg quirks). Collections use the shared
  // resolveManyRelationship contract.
  async function related(sourceModel: string, relName: string, source: any) {
    const adapter = orm.getModelAdapter(sourceModel);
    const assoc = adapter.getAssociations(sourceModel)[relName];
    const spk = adapter.getPrimaryKeyNameForModel(sourceModel)[0];
    if (assoc.associationType === "belongsTo") {
      const fkVal = source[assoc.foreignKey];
      if (fkVal == null) return null;
      const tpk = adapter.getPrimaryKeyNameForModel(assoc.target)[0];
      return one(assoc.target, { [tpk]: fkVal });
    }
    if (assoc.associationType === "hasOne") {
      return one(assoc.target, { [assoc.foreignKey]: source[assoc.sourceKey || spk] });
    }
    const { models } = await adapter.resolveManyRelationship(assoc.target, assoc, source, {}, 0, undefined, undefined, {}, false);
    return models;
  }

  // Read a to-many relation from a FRESHLY re-queried source (a stale source can
  // carry adapter-cached associations, e.g. Sequelize's eager-loaded values).
  const posts = async () => (await related("Author", "posts", await one("Author", { name: "dave" }))).map((p: any) => p.title).sort();
  const tags = async () => (await related("Post", "tags", await one("Post", { title: "bm" }))).map((t: any) => t.label).sort();

  it("belongsTo — nested create, set, remove", async () => {
    const post = await create("Post", { title: "p1", author: { create: { name: "alice" } } });
    const alice = await one("Author", { name: "alice" });
    expect(post.authorId).toEqual(alice.id);

    await create("Author", { name: "bob" });
    await create("Post", { title: "p2" });
    await update("Post", { title: { eq: "p2" } }, { author: { set: { name: { eq: "bob" } } } });
    expect((await one("Post", { title: "p2" })).authorId).toEqual((await one("Author", { name: "bob" })).id);

    await update("Post", { title: { eq: "p2" } }, { author: { remove: true } });
    expect((await one("Post", { title: "p2" })).authorId == null).toBe(true);
  });

  it("hasOne — nested create + read", async () => {
    const author = await create("Author", { name: "carol", profile: { create: { bio: "hello" } } });
    const profile = await related("Author", "profile", await one("Author", { name: "carol" }));
    expect(profile.bio).toBe("hello");
    expect(profile.authorId).toEqual(author.id);
  });

  it("hasMany — nested create, add, set, remove", async () => {
    await create("Author", { name: "dave", posts: { create: [{ title: "d1" }, { title: "d2" }] } });
    expect(await posts()).toEqual(["d1", "d2"]);

    await create("Post", { title: "loose" });
    await update("Author", { name: { eq: "dave" } }, { posts: { add: [{ title: { eq: "loose" } }] } });
    expect(await posts()).toEqual(["d1", "d2", "loose"]);

    await update("Author", { name: { eq: "dave" } }, { posts: { set: [{ title: { eq: "loose" } }] } });
    expect(await posts()).toEqual(["loose"]);

    await update("Author", { name: { eq: "dave" } }, { posts: { remove: [{ title: { eq: "loose" } }] } });
    expect(await posts()).toEqual([]);
  });

  it("belongsToMany — nested create, add (+through), remove, reverse read", async () => {
    const post = await create("Post", { title: "bm", tags: { create: [{ label: "t1" }, { label: "t2" }] } });
    expect(await tags()).toEqual(["t1", "t2"]);

    // Reverse direction.
    expect((await related("Tag", "posts", await one("Tag", { label: "t1" }))).map((p: any) => p.title)).toEqual(["bm"]);

    // add an existing tag (with a through column — accepted by both adapters).
    await create("Tag", { label: "t3" });
    await update("Post", { title: { eq: "bm" } }, { tags: { add: [{ where: { label: { eq: "t3" } }, through: { sortOrder: 7 } }] } });
    expect(await tags()).toEqual(["t1", "t2", "t3"]);

    // remove one.
    await update("Post", { title: { eq: "bm" } }, { tags: { remove: [{ label: { eq: "t1" } }] } });
    expect(await tags()).toEqual(["t2", "t3"]);
  });

  it("transaction — commit persists a multi-record graph", async () => {
    await orm.transaction(async () => {
      await create("Author", { name: "eve", posts: { create: [{ title: "e1" }, { title: "e2" }] } });
    });
    expect((await list("Author", { name: "eve" })).length).toBe(1);
    expect((await list("Post")).length).toBe(2);
  });

  it("transaction — rollback leaves nothing", async () => {
    await expect(
      orm.transaction(async () => {
        await create("Author", { name: "frank", posts: { create: [{ title: "f1" }] } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await list("Author", { name: "frank" })).length).toBe(0);
    expect((await list("Post")).length).toBe(0);
  });
});
