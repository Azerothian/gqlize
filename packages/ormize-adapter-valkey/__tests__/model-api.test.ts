import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type { Definition } from "@azerothian/utilize/types/index";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;

// Portable models with user class/instance methods; a plain hasMany for finders.
// Annotated as `Definition[]` (rather than left to the array-literal's own
// inferred union) so each object is checked against the real contract type
// on its own, instead of TS synthesizing a merged shape across both literals.
const makeDefs = (): Definition[] => [
  {
    name: "Author",
    define: { name: { type: DataTypes.String, index: true } },
    options: {
      classMethods: { hello: () => "class-hello" },
      instanceMethods: { greet(this: { name: string }) { return `hi ${this.name}`; } },
    },
    relationships: [{ type: "hasMany", model: "Post", name: "posts", options: { foreignKey: "authorId" } }],
  },
  {
    name: "Post",
    define: { title: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [{ type: "belongsTo", model: "Author", name: "author", options: { foreignKey: "authorId" } }],
  },
];

const backends = [
  { name: "sequelize", makeAdapter: () => new SequelizeAdapter({}, { dialect: "sqlite", logging: false }) },
  { name: "valkey", makeAdapter: () => new ValkeyAdapter({ prefix: "api" }, client) },
];

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });

describe.each(backends)("$name adapter — Sequelize-style model API", ({ name, makeAdapter }) => {
  let orm: Ormize;
  beforeEach(async () => {
    if (name === "valkey") await flush(client);
    orm = new Ormize();
    orm.registerAdapter(makeAdapter(), "db");
    for (const d of makeDefs()) await orm.addDefinition(d);
    await orm.initialise();
    await orm.sync();
  });

  it("static model CRUD on orm.models.X", async () => {
    const Author = orm.models.Author;
    const a = await Author.create({ name: "ada" });
    expect(a.name).toBe("ada");
    expect((await Author.findAll({ where: { name: "ada" } })).length).toBe(1);
    expect((await Author.findByPk(a.id)).name).toBe("ada");
    expect((await Author.findOne({ where: { name: "ada" } })).id).toEqual(a.id);
    expect(await Author.count({ where: { name: "ada" } })).toBe(1);

    await Author.update({ name: "ada2" }, { where: { name: "ada" } });
    expect((await Author.findOne({ where: { name: "ada2" } })).id).toEqual(a.id);

    await Author.destroy({ where: { name: "ada2" } });
    expect(await Author.count({})).toBe(0);
  });

  it("instance save / update / destroy / reload / get / toJSON", async () => {
    const a = await orm.models.Author.create({ name: "bob" });
    a.name = "bobby";
    await a.save();
    expect((await orm.models.Author.findByPk(a.id)).name).toBe("bobby");

    await a.update({ name: "bobby2" });
    expect((await orm.models.Author.findByPk(a.id)).name).toBe("bobby2");

    a.name = "stale";
    await a.reload();
    expect(a.name).toBe("bobby2");
    expect(a.get("name")).toBe("bobby2");
    expect(a.toJSON().name).toBe("bobby2");

    await a.destroy();
    expect(await orm.models.Author.findByPk(a.id)).toBeNull();
  });

  it("class methods + instance methods", async () => {
    expect(orm.models.Author.hello()).toBe("class-hello");
    const a = await orm.models.Author.create({ name: "cara" });
    expect(a.greet()).toBe("hi cara");
  });

  it("relational finders — getPosts, addPost, countPosts", async () => {
    const a = await orm.models.Author.create({ name: "dan" });
    await orm.models.Post.create({ title: "p1", authorId: a.id });
    const p2 = await orm.models.Post.create({ title: "p2" });

    const fresh = await orm.models.Author.findByPk(a.id);
    expect((await fresh.getPosts()).map((p: { title: string }) => p.title)).toEqual(["p1"]);

    await fresh.addPost(p2); // associate an existing record
    expect((await fresh.getPosts()).map((p: { title: string }) => p.title).sort()).toEqual(["p1", "p2"]);
    expect(await fresh.countPosts()).toBe(2);
  });
});
