import type {GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect, jest} from "@jest/globals";
import {Ormize, MemoryCacheStore} from "@azerothian/ormize";
import type {CacheOptions} from "@azerothian/ormize";
import {fingerprint, hash} from "@azerothian/ormize/read-cache/fingerprint";
import {encode, decode} from "@azerothian/ormize/read-cache/codec";

import {registerDialectAdapter} from "../helper/dialect";
import {createSchema} from "../../src";
import {ask} from "../helper";
import {LIBRARY} from "../helper/models/library";

// Opt-in benchmark for the read cache; not part of `pnpm test`.
//
//   pnpm --filter @azerothian/gqlize exec jest --selectProjects sqlite \
//     --testMatch '**/__tests__/bench/*.bench.ts' --coverage=false
//
// Prints median timings, end to end through GraphQL and per cache phase, so a
// change to the cache can be compared before and after.

const AUTHORS = 300;
const BOOKS_PER_AUTHOR = 5;

async function build(cache?: Partial<CacheOptions>) {
  const db = new Ormize(cache ? {cache: {store: new MemoryCacheStore({maxEntries: 0, maxSize: 0}), ...cache}} : {});
  const adapter = await registerDialectAdapter(db);
  for (const def of LIBRARY) {
    await db.addDefinition(def);
  }
  await db.initialise();
  await db.sync();
  type M = {bulkCreate: (rows: object[]) => Promise<{get: (k: string) => unknown}[]>};
  const {Author, Book, Tag} = db.models as unknown as Record<string, M>;
  const tags = await Tag.bulkCreate(Array.from({length: 10}, (_, i) => ({name: `tag${i}`})));
  const authors = await Author.bulkCreate(Array.from({length: AUTHORS}, (_, i) => ({name: `author${i}`, bio: "x".repeat(200)})));
  const books = await Book.bulkCreate(authors.flatMap((a, i) => Array.from({length: BOOKS_PER_AUTHOR}, (_, j) => ({
    title: `book${i}-${j}`, publishedAt: new Date(2000, 0, 1 + j), authorId: a.get("id"),
  }))));
  const BookTags = (adapter as unknown as {sequelize: Sequelize.Sequelize}).sequelize.models.BookTags as unknown as M;
  await BookTags.bulkCreate(books.flatMap((b, i) => [0, 1].map((k) => ({bookId: b.get("id"), tagId: tags[(i + k) % 10].get("id")}))));
  return {db, adapter, schema: await createSchema(db)};
}

const run = (schema: GraphQLSchema, source: string) => ask(schema, source);

async function median(iterations: number, fn: () => Promise<unknown> | unknown, before?: () => Promise<unknown> | unknown) {
  const samples: number[] = [];
  for (let i = 0; i < iterations + 3; i++) {
    await before?.();
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    if (i >= 3) {
      samples.push(elapsed); // the first three are warm-up
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const fmt = (ms: number) => `${ms.toFixed(3)} ms`;

const QUERIES: Record<string, string> = {
  "list 50 (flat)": `{ models { Author(first: 50) { total edges { node { id name } } } } }`,
  "list 50 (deep: books + tags)": `{ models { Author(first: 50) { total edges { node { id name books { edges { node { title publishedAt tags { edges { node { name } } } } } } } } } } }`,
  "list 500 (deep)": `{ models { Author(first: 500) { edges { node { name books { edges { node { title tags { edges { node { name } } } } } } } } } } }`,
  "filtered + sorted": `{ models { Book(where: {title: {like: "book1%"}}, orderBy: titleDESC, first: 100) { total edges { node { title } } } } }`,
  "count only": `{ models { Book { total } } }`,
};

describe("read cache benchmark", () => {
  jest.setTimeout(600_000);

  it("end to end through GraphQL", async() => {
    const plain = await build();
    const cached = await build({});
    const rows: string[][] = [["query", "uncached", "cached miss", "cached hit", "hit speedup"]];
    for (const [name, source] of Object.entries(QUERIES)) {
      const iterations = name.includes("500") ? 15 : 60;
      const base = await median(iterations, () => run(plain.schema, source));
      const miss = await median(iterations, () => run(cached.schema, source), () => cached.db.readCache?.clear());
      // Timing a wrong answer would be worthless: a hit has to equal the database.
      expect(await run(cached.schema, source)).toEqual(await run(plain.schema, source));
      const hit = await median(iterations, () => run(cached.schema, source));
      rows.push([name, fmt(base), fmt(miss), fmt(hit), `${(base / hit).toFixed(1)}x`]);
    }
    console.log(`\nEnd to end (median, sqlite, ${AUTHORS} authors x ${BOOKS_PER_AUTHOR} books)\n` + rows.map((r) => r.join(" | ")).join("\n"));  
  });

  it("where a miss and a hit spend their time", async() => {
    const {db, adapter, schema} = await build({});
    const rows: string[][] = [["query", "rows", "fingerprint+hash", "snapshot", "encode", "bytes", "decode", "restore", "adapter.findAll"]];
    for (const name of ["list 50 (flat)", "list 50 (deep: books + tags)", "list 500 (deep)"]) {
      const spy = jest.spyOn(adapter, "findAll");
      await db.readCache?.clear();
      await run(schema, QUERIES[name]);
      const options = spy.mock.calls[spy.mock.calls.length - 1][1];
      spy.mockRestore();
      const found = await adapter.findAll("Author", options);
      const snapshotRows = adapter.snapshotRows!.bind(adapter);  
      const restoreRows = adapter.restoreRows!.bind(adapter);  
      const snapshot = snapshotRows("Author", found, options);
      const text = encode(snapshot);
      const parsed = decode(text) as unknown[];
      expect(restoreRows("Author", parsed, options)).toHaveLength(found.length);
      const iterations = name.includes("500") ? 15 : 60;
      rows.push([
        name,
        String(found.length),
        fmt(await median(iterations, () => hash(fingerprint(options) as string))),
        fmt(await median(iterations, () => snapshotRows("Author", found, options))),
        fmt(await median(iterations, () => encode(snapshot))),
        `${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB`,
        fmt(await median(iterations, () => decode(text))),
        fmt(await median(iterations, () => restoreRows("Author", parsed, options))),
        fmt(await median(iterations, () => adapter.findAll("Author", options))),
      ]);
    }
    console.log("\nPer phase (median)\n" + rows.map((r) => r.join(" | ")).join("\n"));  
  });

  it("deduplication under a cold burst", async() => {
    const rows: string[][] = [["burst", "dedupe", "wall time", "adapter calls"]];
    for (const dedupe of [true, false]) {
      const {adapter, schema, db} = await build({dedupe});
      const spy = jest.spyOn(adapter, "findAll");
      for (const burst of [10, 50]) {
        await db.readCache?.clear();
        const before = spy.mock.calls.length;
        const start = performance.now();
        await Promise.all(Array.from({length: burst}, () => run(schema, QUERIES["list 50 (deep: books + tags)"])));
        const calls = spy.mock.calls.length - before;
        expect(calls).toBe(dedupe ? 1 : burst);
        rows.push([String(burst), String(dedupe), fmt(performance.now() - start), String(calls)]);
      }
    }
    console.log("\nCold burst of identical reads\n" + rows.map((r) => r.join(" | ")).join("\n"));  
  });

  it("what a write pays for invalidation", async() => {
    const rows: string[][] = [["engine", "update mutation"]];
    for (const cache of [undefined, {}]) {
      const {schema} = await build(cache);
      let n = 0;
      const t = await median(60, () => run(schema, `mutation { models { Author(update: {where: {name: {eq: "author1"}}, input: {bio: "b${n++}"}}) { id } } }`));
      expect(await run(schema, `{ models { Author(where: {name: {eq: "author1"}}) { edges { node { bio } } } } }`))
        .toEqual({models: {Author: {edges: [{node: {bio: `b${n - 1}`}}]}}});
      rows.push([cache ? "cached" : "uncached", fmt(t)]);
    }
    console.log("\nWrite cost\n" + rows.map((r) => r.join(" | ")).join("\n"));  
  });
});
