/**
 * belongsToMany `through`: when a relationship carries join-row data, what
 * shape its `add`/`set` entries take, and what a `through` payload may write.
 *
 * Through mode needs a join model the author registered and the permission
 * bag lets be seen; otherwise the relationship is a plain many-to-many and its
 * entries are bare filters. Whatever the route, a payload never writes the
 * join keys or the join row's primary key — the regression tests for a payload
 * that used to point a link at a row the caller never named.
 */
import {graphql, GraphQLInputObjectType, type GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {Ormize as Database, ThroughInputError} from "@azerothian/ormize";
import {createSchema} from "../src";
import {registerDialectAdapter} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";
import type {Definition} from "../src/types";

type Row = {get: (k: string) => unknown};
type Linkable = Row & {addTags: (t: unknown[]) => Promise<void>};

function defs(registeredJoin: boolean): Definition[] {
  const through = registeredJoin ? {model: "PostTag"} : "PostTagImplicit";
  const out: Definition[] = [
    {name: "Post", define: {title: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsToMany", model: "Tag", name: "tags", options: {through, foreignKey: "postId", otherKey: "tagId"}}]},
    {name: "Tag", define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsToMany", model: "Post", name: "posts", options: {through, foreignKey: "tagId", otherKey: "postId"}}]},
  ];
  if (registeredJoin) {
    out.push({name: "PostTag", define: {
      sortOrder: {type: Sequelize.INTEGER, allowNull: true},
      label: {type: Sequelize.STRING, allowNull: true},
      secret: {type: Sequelize.STRING, allowNull: true},
    }, ignoreFields: ["secret"]});
  }
  return out;
}

async function build(registeredJoin: boolean) {
  const db = new Database();
  await registerDialectAdapter(db);
  for (const d of defs(registeredJoin)) {
    await db.addDefinition(d);
  }
  await db.initialise();
  await db.sync();
  return db;
}

async function joinRows(db: Database, model: string): Promise<Record<string, unknown>[]> {
  const sequelize = (db.getModelAdapter("Post") as unknown as {sequelize: Sequelize.Sequelize}).sequelize;
  return await sequelize.models[model].findAll({raw: true}) as unknown as Record<string, unknown>[];
}

/** `mine` linked to `t1`, plus an unrelated `victim` post. */
async function seed(db: Database) {
  const {Post, Tag} = db.models;
  const victim = await Post.create({title: "victim"}) as unknown as Row;
  const mine = await Post.create({title: "mine"}) as unknown as Linkable;
  const tag = await Tag.create({name: "t1"}) as unknown as Row;
  await mine.addTags([tag]);
  return {victim, mine, tag};
}

const addEntryType = (schema: GraphQLSchema) => {
  const input = schema.getType("PostTagsBelongsToManyInput") as GraphQLInputObjectType;
  return String(input.getFields().add.type);
};

describe("belongsToMany through — schema", () => {
  it("types the payload by the join model's writable columns", async () => {
    const db = await build(true);
    const schema = await createSchema(db, {});
    const through = schema.getType("PostTagsThroughInput") as GraphQLInputObjectType;
    expect(through).toBeInstanceOf(GraphQLInputObjectType);
    const fields = through.getFields();
    // Join keys are set by the association, `secret` is in ignoreFields.
    expect(Object.keys(fields).sort()).toEqual(["createdAt", "label", "sortOrder", "updatedAt"]);
    expect(String(fields.sortOrder.type)).toBe("Int");
    expect(addEntryType(schema)).toBe("[PostTagsAddThrough]");
    const entry = schema.getType("PostTagsAddThrough") as GraphQLInputObjectType;
    expect(entry.getFields().through.type).toBe(through);
  });

  it("rejects a key that is not a writable join column", async () => {
    const db = await build(true);
    await seed(db);
    const schema = await createSchema(db, {});
    for (const key of ["nope", "postId", "tagId", "secret"]) {
      const res = await graphql({schema, source: `mutation { models {
        Post(update: {where: {title: {eq: "mine"}}, input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {${key}: 1}}]}}}) { id }
      } }`});
      expect(res.errors?.[0]?.message).toContain(key);
    }
  });

  it("follows mutationCreateInput on the join model", async () => {
    const db = await build(true);
    const schema = await createSchema(db, {permission: {mutationCreateInput: (m: string, f: string) => !(m === "PostTag" && f === "label")}});
    const fields = (schema.getType("PostTagsThroughInput") as GraphQLInputObjectType).getFields();
    expect(fields.label).toBeUndefined();
    expect(fields.sortOrder).toBeDefined();
  });

  it("a join model hidden by permission.model makes it a plain many-to-many", async () => {
    const db = await build(true);
    const schema = await createSchema(db, {permission: {model: (n: string) => n !== "PostTag"}});
    expect(schema.getType("PostTagsThroughInput")).toBeUndefined();
    expect(schema.getType("PostTagsAddThrough")).toBeUndefined();
    expect(addEntryType(schema)).toBe("[GQLTQueryTagWhere]");
  });

  it("an implicit join table makes it a plain many-to-many", async () => {
    const db = await build(false);
    const schema = await createSchema(db, {});
    expect(schema.getType("PostTagsAddThrough")).toBeUndefined();
    expect(addEntryType(schema)).toBe("[GQLTQueryTagWhere]");
  });
});

describe("belongsToMany through — writes", () => {
  it("plain mode: add and set take the bare filter", async () => {
    const db = await build(false);
    await seed(db);
    const t2 = await db.models.Tag.create({name: "t2"}) as unknown as Row;
    const t3 = await db.models.Tag.create({name: "t3"}) as unknown as Row;
    const schema = await createSchema(db, {});
    // `set` runs after `add` (verb order), so only its tag survives.
    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "mine"}}, input: {tags: {add: [{name: {eq: "t2"}}], set: [{name: {eq: "t3"}}]}}}) { id }
    } }`});
    expect(res.errors).toBeUndefined();
    const tagIds = (await joinRows(db, "PostTagImplicit")).map((r) => r.tagId);
    expect(tagIds).toEqual([t3.get("id")]);
    expect(tagIds).not.toContain(t2.get("id"));
  });

  it("plain mode by permission: a hidden join model takes bare filters end to end", async () => {
    const db = await build(true);
    await seed(db);
    const t2 = await db.models.Tag.create({name: "t2"}) as unknown as Row;
    const schema = await createSchema(db, {permission: {model: (n: string) => n !== "PostTag"}});
    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "mine"}}, input: {tags: {add: [{name: {eq: "t2"}}]}}}) { id }
    } }`});
    expect(res.errors).toBeUndefined();
    expect((await joinRows(db, "PostTag")).map((r) => r.tagId)).toContain(t2.get("id"));
  });

  it("through mode: the engine refuses a bare filter", async () => {
    const db = await build(true);
    await seed(db);
    await db.models.Tag.create({name: "t2"});
    await expect(db.processUpdate("Post", null, {where: {title: {eq: "mine"}}, input: {tags: {add: [{name: {eq: "t2"}}]}}}, {}, undefined))
      .rejects.toBeInstanceOf(ThroughInputError);
  });

  it("plain mode: the engine refuses a { where, through } entry", async () => {
    const db = await build(false);
    await seed(db);
    await expect(db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {postId: 1}}]}},
    }, {}, undefined)).rejects.toThrow(/carries no join-row data/);
  });

  it("plain mode under the caller's bag: a hidden join model refuses the wrapper", async () => {
    const db = await build(true);
    await seed(db);
    const permission = {model: (n: string) => n !== "PostTag"};
    await expect(db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {sortOrder: 1}}]}},
    }, {}, {permission})).rejects.toBeInstanceOf(ThroughInputError);
  });

  it.each([
    ["a join key", {postId: 1}],
    ["the other join key", {tagId: 1}],
    ["an ignoreFields column", {secret: "x"}],
    ["an unknown column", {nope: 1}],
  ])("the engine refuses %s in through and writes nothing", async (_label, through) => {
    const db = await build(true);
    const {mine, tag} = await seed(db);
    await expect(db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {...through, sortOrder: 3}}]}},
    }, {}, undefined)).rejects.toBeInstanceOf(ThroughInputError);
    expect(await joinRows(db, "PostTag")).toEqual([
      expect.objectContaining({postId: mine.get("id"), tagId: tag.get("id"), sortOrder: null}),
    ]);
  });

  it("the engine applies the caller's mutationCreateInput to through", async () => {
    const db = await build(true);
    await seed(db);
    const permission = {mutationCreateInput: (m: string, f: string) => !(m === "PostTag" && f === "label")};
    await expect(db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {label: "x"}}]}},
    }, {}, {permission})).rejects.toThrow(/'label'/);
    await db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {sortOrder: 2}}]}},
    }, {}, {permission});
    expect((await joinRows(db, "PostTag"))[0].sortOrder).toBe(2);
  });

  it("set gives each entry its own through and drops unlisted links", async () => {
    const db = await build(true);
    const {mine} = await seed(db);
    const t2 = await db.models.Tag.create({name: "t2"}) as unknown as Row;
    const t3 = await db.models.Tag.create({name: "t3"}) as unknown as Row;
    const schema = await createSchema(db, {});
    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "mine"}}, input: {tags: {set: [
        {where: {name: {eq: "t2"}}, through: {sortOrder: 2, label: "two"}},
        {where: {name: {eq: "t3"}}, through: {sortOrder: 3}},
      ]}}}) { id }
    } }`});
    expect(res.errors).toBeUndefined();
    const rows = (await joinRows(db, "PostTag")).filter((r) => r.postId === mine.get("id"));
    const byTag = Object.fromEntries(rows.map((r) => [r.tagId, r]));
    expect(Object.keys(byTag).map(Number).sort()).toEqual([t2.get("id"), t3.get("id")].map(Number).sort());
    expect(byTag[String(t2.get("id"))]).toEqual(expect.objectContaining({sortOrder: 2, label: "two"}));
    expect(byTag[String(t3.get("id"))]).toEqual(expect.objectContaining({sortOrder: 3, label: null}));
  });

  it("set without any through keeps the single replace", async () => {
    const db = await build(true);
    const {mine} = await seed(db);
    await db.processUpdate("Post", null, {
      where: {title: {eq: "mine"}},
      input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {sortOrder: 9}}]}},
    }, {}, undefined);
    await db.processUpdate("Post", null, {where: {title: {eq: "mine"}}, input: {tags: {set: [{where: {name: {eq: "t1"}}}]}}}, {}, undefined);
    const rows = (await joinRows(db, "PostTag")).filter((r) => r.postId === mine.get("id"));
    // Sequelize keeps an existing link's columns when `set` passes no values.
    expect(rows.map((r) => r.sortOrder)).toEqual([9]);
  });
});
