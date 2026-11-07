import type {GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect, jest} from "@jest/globals";
import {Ormize, MemoryCacheStore, Events} from "@azerothian/ormize";
import type {CacheOptions} from "@azerothian/ormize";

import {registerDialectAdapter} from "./helper/dialect";
import {ask} from "./helper";
import {AuthorModel, BookModel, LIBRARY, TagModel} from "./helper/models/library";
import {createSchema} from "../src";
import type {Definition} from "../src/types/index";

// The read cache sits under every surface, so a hit has to be indistinguishable
// from a miss. Most tests here run a query twice and compare the output, then
// count how many times the adapter was actually asked.

async function build(cache?: Partial<CacheOptions> | false, defs: Definition[] = LIBRARY) {
  const store = new MemoryCacheStore();
  const db = new Ormize(cache === false ? {} : {cache: {store, onError: (e) => { throw e; }, ...cache}});
  const adapter = await registerDialectAdapter(db);
  for (const def of defs) {
    await db.addDefinition(def);
  }
  await db.initialise();
  await db.sync();
  const findAll = jest.spyOn(adapter, "findAll");
  const count = jest.spyOn(adapter, "count");
  return {db, store, findAll, count, schema: await createSchema(db)};
}

async function seed(db: Ormize) {
  const {Author, Book, Tag} = db.models;
  const ada = await Author.create({name: "ada"});
  const grace = await Author.create({name: "grace"});
  const [red, blue] = [await Tag.create({name: "red"}), await Tag.create({name: "blue"})];
  const b1 = await Book.create({title: "notes", authorId: ada.get("id"), publishedAt: new Date("1843-07-01T00:00:00.000Z")});
  await Book.create({title: "cobol", authorId: grace.get("id")});
  await (b1 as unknown as {setTags: (t: unknown[]) => Promise<void>}).setTags([red, blue]);
}

const run = (schema: GraphQLSchema, source: string) => ask(schema, source);

const DEEP = `query { models { Author { total edges { node { id name books { total edges { node {
  id title publishedAt tags { total edges { node { name } } } } } } } } } } }`;

describe("read cache", () => {
  it("answers a repeat read from the cache, with the same nested result", async() => {
    const uncached = await build(false);
    await seed(uncached.db);
    const expected = await run(uncached.schema, DEEP);

    const {db, schema, findAll} = await build();
    await seed(db);
    const first = await run(schema, DEEP);
    const callsAfterMiss = findAll.mock.calls.length;
    const second = await run(schema, DEEP);

    expect(first).toEqual(expected);
    expect(second).toEqual(first);
    expect(callsAfterMiss).toBeGreaterThan(0);
    expect(findAll.mock.calls.length).toBe(callsAfterMiss);
    // The date survived the round trip as a date, not as whatever string JSON made of it.
    const books = (second as {models: {Author: {edges: {node: {books: {edges: {node: {publishedAt: unknown}}[]}}}[]}}})
      .models.Author.edges[0].node.books.edges;
    expect(books[0].node.publishedAt).toEqual(
      (expected as typeof second & {models: {Author: {edges: {node: {books: {edges: {node: {publishedAt: unknown}}[]}}}[]}}})
        .models.Author.edges[0].node.books.edges[0].node.publishedAt);
  });

  it("keys on the filter, including operators keyed by symbol", async() => {
    const {db, schema} = await build();
    await seed(db);
    const ada = await run(schema, `query { models { Author(where: {name: {in: ["ada"]}}) { edges { node { name } } } } }`);
    const grace = await run(schema, `query { models { Author(where: {name: {in: ["grace"]}}) { edges { node { name } } } } }`);
    expect(ada).toEqual({models: {Author: {edges: [{node: {name: "ada"}}]}}});
    expect(grace).toEqual({models: {Author: {edges: [{node: {name: "grace"}}]}}});
  });

  it("caches a count-only read", async() => {
    const {db, schema, count} = await build();
    await seed(db);
    await run(schema, `query { models { Book { total } } }`);
    const calls = count.mock.calls.length;
    const again = await run(schema, `query { models { Book { total } } }`);
    expect(again).toEqual({models: {Book: {total: 2}}});
    expect(count.mock.calls.length).toBe(calls);
  });

  it("invalidates after a GraphQL mutation", async() => {
    const {db, schema} = await build();
    await seed(db);
    await run(schema, DEEP);
    await run(schema, `mutation { models { Author(update: {where: {name: {eq: "ada"}}, input: {name: "lovelace"}}) { id } } }`);
    const after = await run(schema, `query { models { Author { edges { node { name } } } } }`);
    expect(after).toEqual({models: {Author: {edges: [{node: {name: "lovelace"}}, {node: {name: "grace"}}]}}});
  });

  it("invalidates a read that eager-loaded the written model", async() => {
    const {db, schema} = await build();
    await seed(db);
    const titles = async() => {
      const data = await run(schema, `query { models { Author(where: {name: {eq: "ada"}}) { edges { node { books { edges { node { title } } } } } } } }`) as
        {models: {Author: {edges: {node: {books: {edges: {node: {title: string}}[]}}}[]}}};
      return data.models.Author.edges[0].node.books.edges.map((e) => e.node.title).sort();
    };
    expect(await titles()).toEqual(["notes"]);
    const {Book} = db.models;
    // Straight through the model: no `process*` entry point, only the adapter's hooks.
    const [ada] = await (db.models.Author as unknown as {findAll: (o: object) => Promise<{get: (k: string) => unknown}[]>}).findAll({where: {name: "ada"}});
    await Book.create({title: "sketch", authorId: ada.get("id")});
    expect(await titles()).toEqual(["notes", "sketch"]);
  });

  it("invalidates a join-table write made by a relationship verb", async() => {
    const {db, schema} = await build();
    await seed(db);
    const tagsOf = async() => {
      const data = await run(schema, `query { models { Book(where: {title: {eq: "cobol"}}) { edges { node { tags { edges { node { name } } } } } } } }`) as
        {models: {Book: {edges: {node: {tags: {edges: {node: {name: string}}[]}}}[]}}};
      return data.models.Book.edges[0].node.tags.edges.map((e) => e.node.name);
    };
    expect(await tagsOf()).toEqual([]);
    // `BookTags` is an implicit join table: no definition, so no hooks of its
    // own. The verb runs inside the mutation entry point, whose footprint names it.
    await run(schema, `mutation { models { Book(update: {where: {title: {eq: "cobol"}}, input: {tags: {add: [{where: {name: {eq: "red"}}}]}}}) { id } } }`);
    expect(await tagsOf()).toEqual(["red"]);
  });

  it("can be invalidated by hand for a write ormize never saw", async() => {
    const {db, schema} = await build();
    await seed(db);
    const source = `query { models { Tag { total } } }`;
    expect(await run(schema, source)).toEqual({models: {Tag: {total: 2}}});
    const adapter = db.adapters[Object.keys(db.adapters)[0]] as unknown as {sequelize: Sequelize.Sequelize};
    await adapter.sequelize.query(`INSERT INTO "Tags" ("name", "createdAt", "updatedAt") VALUES ('raw', '2020-01-01', '2020-01-01')`);
    expect(await run(schema, source)).toEqual({models: {Tag: {total: 2}}});
    await db.readCache?.invalidate(["Tag"]);
    expect(await run(schema, source)).toEqual({models: {Tag: {total: 3}}});
  });

  it("does not cache reads inside a transaction, and invalidates on commit", async() => {
    const {db, schema, findAll} = await build();
    await seed(db);
    const names = `query { models { Tag { edges { node { name } } } } }`;
    await run(schema, names);
    await db.transaction(async() => {
      const before = findAll.mock.calls.length;
      await run(schema, names);
      await run(schema, names);
      expect(findAll.mock.calls.length).toBe(before + 2);
      await run(schema, `mutation { models { Tag(create: {name: "green"}) { id } } }`);
    });
    const after = await run(schema, names) as {models: {Tag: {edges: {node: {name: string}}[]}}};
    expect(after.models.Tag.edges.map((e) => e.node.name)).toContain("green");
  });

  it("shares one adapter call between concurrent identical reads", async() => {
    const {db, schema, findAll} = await build();
    await seed(db);
    const source = `query { models { Author { edges { node { name } } } } }`;
    const before = findAll.mock.calls.length;
    const results = await Promise.all([run(schema, source), run(schema, source), run(schema, source)]);
    expect(findAll.mock.calls.length).toBe(before + 1);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("runs each concurrent read separately with dedupe off", async() => {
    const {db, schema, findAll} = await build({dedupe: false});
    await seed(db);
    const source = `query { models { Author { edges { node { name } } } } }`;
    const before = findAll.mock.calls.length;
    await Promise.all([run(schema, source), run(schema, source)]);
    expect(findAll.mock.calls.length).toBe(before + 2);
  });

  describe("exclusions", () => {
    const source = `query { models { Author { edges { node { name } } } } }`;

    async function callsFor(cache: Partial<CacheOptions>, defs?: Definition[]) {
      const {db, schema, findAll} = await build(cache, defs);
      await seed(db);
      const before = findAll.mock.calls.length;
      await run(schema, source);
      await run(schema, source);
      return findAll.mock.calls.length - before;
    }

    it("skips a model named in `exclude`", async() => {
      expect(await callsFor({exclude: ["Author"]})).toBe(2);
      expect(await callsFor({exclude: ["Book"]})).toBe(1);
    });

    it("skips a read the `exclude` predicate rejects", async() => {
      expect(await callsFor({exclude: ({defName, operation}) => defName === "Author" && operation === "findAll"})).toBe(2);
    });

    it("skips a definition with `cache: false`", async() => {
      expect(await callsFor({}, [{...AuthorModel, cache: false}, BookModel, TagModel])).toBe(2);
    });

    it("skips a model with its own find hooks unless told otherwise", async() => {
      const hooked = {...AuthorModel, hooks: {afterFind: (rows: unknown) => rows}};
      expect(await callsFor({}, [hooked, BookModel, TagModel])).toBe(2);
      expect(await callsFor({hooks: "cache"}, [hooked, BookModel, TagModel])).toBe(1);
      expect(await callsFor({}, [{...hooked, cache: {}}, BookModel, TagModel])).toBe(1);
    });
  });

  it("partitions entries by `vary`", async() => {
    let viewer = "a";
    const {db, schema, findAll} = await build({vary: () => viewer});
    await seed(db);
    const source = `query { models { Author { edges { node { name } } } } }`;
    const before = findAll.mock.calls.length;
    await run(schema, source);
    viewer = "b";
    await run(schema, source);
    viewer = "a";
    await run(schema, source);
    expect(findAll.mock.calls.length).toBe(before + 2);
  });

  it("tags an include a `before` hook adds in association form", async() => {
    const withBooks: Definition = {
      ...AuthorModel,
      before: ({params, type}) => {
        if (type === Events.QUERY) {
          const p = params as {include?: unknown[]};
          p.include = [...(p.include || []), {association: "books"}];
        }
        return params;
      },
    };
    const {db, schema, findAll} = await build({}, [withBooks, BookModel, TagModel]);
    await seed(db);
    const source = `query { models { Author { edges { node { name } } } } }`;
    await run(schema, source);
    const before = findAll.mock.calls.length;
    await run(schema, source);
    expect(findAll.mock.calls.length).toBe(before);
    const [ada] = await (db.models.Author as unknown as {findAll: (o: object) => Promise<{get: (k: string) => unknown}[]>}).findAll({where: {name: "ada"}});
    await db.models.Book.create({title: "sketch", authorId: ada.get("id")});
    await run(schema, source);
    expect(findAll.mock.calls.length).toBe(before + 1);
  });

  it("reads uncached when `vary` throws", async() => {
    const errors: unknown[] = [];
    const {db, schema, findAll} = await build({vary: () => { throw new Error("no session"); }, onError: (e) => errors.push(e)});
    await seed(db);
    const source = `query { models { Author { edges { node { name } } } } }`;
    const before = findAll.mock.calls.length;
    expect(await run(schema, source)).toEqual({models: {Author: {edges: [{node: {name: "ada"}}, {node: {name: "grace"}}]}}});
    await run(schema, source);
    expect(findAll.mock.calls.length).toBe(before + 2);
    expect(errors).toHaveLength(2);
  });

  it("returns but does not store a result over `maxEntrySize`", async() => {
    const {db, schema, store} = await build({maxEntrySize: 10});
    await seed(db);
    const data = await run(schema, `query { models { Author { edges { node { name } } } } }`);
    expect(data).toEqual({models: {Author: {edges: [{node: {name: "ada"}}, {node: {name: "grace"}}]}}});
    expect(store.size).toBe(0);
  });

  it("falls through to the adapter when the store fails", async() => {
    const errors: unknown[] = [];
    const broken = new MemoryCacheStore();
    broken.get = () => Promise.reject(new Error("down"));
    broken.versions = () => Promise.reject(new Error("down"));
    const {db, schema} = await build({store: broken, onError: (e) => errors.push(e)});
    await seed(db);
    const data = await run(schema, `query { models { Author { edges { node { name } } } } }`);
    expect(data).toEqual({models: {Author: {edges: [{node: {name: "ada"}}, {node: {name: "grace"}}]}}});
    expect(errors.length).toBeGreaterThan(0);
  });
});
