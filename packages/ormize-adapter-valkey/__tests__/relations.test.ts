import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize, type MutationFilter, type MutationInputTree } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { AdapterWhere, Definition, Selection } from "@azerothian/utilize/types/index";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;

/**
 * A row as either adapter returns it — a Sequelize model instance or a plain
 * Valkey hash. This suite runs the same assertions against both backends and
 * reads dynamic fields (`title`, `label`, `authorId`, ...) off whichever one
 * produced the row, so there is no one real shape to name here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above: two different adapters' rows, read dynamically by field name across both
type Row = { [field: string]: any };

// One portable model set (authored with DataTypes.*) covering all four relation
// types, run against BOTH adapters:
//   Author hasOne Profile, Author hasMany Post, Post belongsTo Author,
//   Post belongsToMany Tag (through PostTag with a sortOrder column).
// One shared, reused definition set — deliberately, not a factory. Both adapters
// and every test in this file build from these same objects, which is only safe
// because neither adapter writes on a definition it is handed. That makes this
// suite the end-to-end proof of that contract: see
// `packages/ormize/__tests__/config-purity.test.ts` for the unit-level pins.
// No explicit primary key → both adapters synthesize an auto-increment integer
// `id` (Sequelize's default; Valkey via an INCR sequence). Foreign keys are
// auto-created by the relationships (nullable), so set/remove can unlink.
const defs: Definition[] = [
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
  let orm: Ormize;

  beforeEach(async () => {
    if (name === "valkey") await flush(client);
    orm = new Ormize();
    orm.registerAdapter(makeAdapter(), "db");
    for (const d of defs) await orm.addDefinition(d);
    await orm.initialise();
    await orm.sync();
  });

  // `selection` (unused by any call in this file — every call site omits it)
  // forwards to `processCreate`/`processUpdate`'s own trailing `selection?`
  // parameter, not an "options" bag; named for what it actually is.
  const create = (model: string, input: MutationInputTree, selection?: Selection) =>
    orm.processCreate(model, null, { input }, {}, selection).then((r) => r[0] as Row);
  const update = (model: string, where: MutationFilter, input: MutationInputTree, selection?: Selection) =>
    orm.processUpdate(model, null, { input, where }, {}, selection);
  const list = (model: string, where?: AdapterWhere) =>
    orm.resolveFindAll(model, null, where ? { where } : {}, {}, undefined).then((r) => r.models as Row[]);
  const one = async (model: string, where: AdapterWhere) => (await list(model, where))[0];
  // Read a relationship portably via FK/join queries (avoids adapter-specific
  // resolveSingleRelationship arg quirks). Collections use the shared
  // resolveManyRelationship contract.
  async function related(sourceModel: string, relName: string, source: Row) {
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
    const { models } = await adapter.resolveManyRelationship(assoc.target, assoc, source, {args: {}, offset: 0});
    return models as Row[];
  }

  // Read a to-many relation from a FRESHLY re-queried source (a stale source can
  // carry adapter-cached associations, e.g. Sequelize's eager-loaded values).
  // `related` is called here for hasMany/belongsToMany associations only, so its
  // result is always the collection branch (`Row[]`), never the single-row or
  // `null` branches its other callers see.
  const posts = async () => ((await related("Author", "posts", await one("Author", { name: "dave" }))) as Row[]).map((p) => p.title).sort();
  const tags = async () => ((await related("Post", "tags", await one("Post", { title: "bm" }))) as Row[]).map((t) => t.label).sort();

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
    // `related` returns its single-row (`hasOne`) branch here, never a
    // collection — the just-created profile is known present.
    const profile = (await related("Author", "profile", await one("Author", { name: "carol" }))) as Row;
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
    await create("Post", { title: "bm", tags: { create: [{ label: "t1" }, { label: "t2" }] } });
    expect(await tags()).toEqual(["t1", "t2"]);

    // Reverse direction.
    expect(((await related("Tag", "posts", await one("Tag", { label: "t1" }))) as Row[]).map((p) => p.title)).toEqual(["bm"]);

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
