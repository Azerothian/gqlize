import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { printSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import type { MikroORM } from "@mikro-orm/sqlite";
import { makeOrm } from "./helper/orm";

// MikroORM has no soft delete of its own, so it is opted into per entity through
// the definition override and implemented as a column overlay — see
// `src/soft-delete.ts` for why a MikroORM global filter is the wrong mechanism.
const PARANOID = { definitions: { Article: { options: { paranoid: true } } } };

describe("opt-in soft delete", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the note in ormize.test.ts
  let db: any;
  let mikro: MikroORM;

  beforeEach(async () => { ({ db, mikro } = await makeOrm(PARANOID)); });
  afterEach(async () => { await mikro.close(true); });

  async function seed() {
    const author = await db.models.Author.create({ name: "Ada" });
    await db.models.Article.create({ title: "Alpha", status: "draft", authorId: author.id });
    await db.models.Article.create({ title: "Beta", status: "draft", authorId: author.id });
  }

  it("reports only the models that opted in", () => {
    const adapter = db.getModelAdapter("Article");
    expect(adapter.softDeletes("Article")).toBe(true);
    expect(adapter.softDeletes("Author")).toBe(false);
  });

  it("generates the deleted argument and the restore mutation, and only when opted in", async () => {
    const sdl = printSchema(await createSchema(db));
    expect(sdl).toContain("deleted: GQLTDeletedFilter");
    expect(sdl).toMatch(/restore soft-deleted elements for Article/);
    expect(sdl).not.toMatch(/restore soft-deleted elements for Author/);

    // Without the opt-in there is nothing for either to act on, so neither is
    // generated anywhere in the schema.
    const plain = await makeOrm();
    try {
      const plainSdl = printSchema(await createSchema(plain.db));
      expect(plainSdl).not.toContain("GQLTDeletedFilter");
      expect(plainSdl).not.toMatch(/restore soft-deleted elements/);
    } finally {
      await plain.mikro.close(true);
    }
  });

  it("writes the column instead of removing the row, and hides it afterwards", async () => {
    await seed();
    await db.processDelete("Article", null, { title: { eq: "Alpha" } }, {});
    // Gone from an ordinary read...
    expect((await db.resolveFindAll("Article", null, {}, {})).total).toBe(1);
    // ...but still in the table.
    expect(await mikro.em.fork().count("Article" as never, {})).toBe(2);
  });

  it("honours the deleted argument in all three positions", async () => {
    await seed();
    await db.processDelete("Article", null, { title: { eq: "Alpha" } }, {});
    expect((await db.resolveFindAll("Article", null, { deleted: "EXCLUDE" }, {})).total).toBe(1);
    expect((await db.resolveFindAll("Article", null, { deleted: "INCLUDE" }, {})).total).toBe(2);
    const only = await db.resolveFindAll("Article", null, { deleted: "ONLY" }, {});
    expect(only.models.map((m: { title: string }) => m.title)).toEqual(["Alpha"]);
  });

  it("restores a soft-deleted row", async () => {
    await seed();
    await db.processDelete("Article", null, { title: { eq: "Alpha" } }, {});
    const restored = await db.processRestore("Article", null, { title: { eq: "Alpha" } }, {});
    expect(restored).toHaveLength(1);
    expect((await db.resolveFindAll("Article", null, {}, {})).total).toBe(2);
  });

  it("restores nothing on a model that does not soft delete", async () => {
    const adapter = db.getModelAdapter("Author");
    await db.models.Author.create({ name: "Ada" });
    // A hard delete has nothing to come back from, so this matches nothing
    // rather than pretending to succeed.
    expect(await adapter.getRestoreFunction("Author")({}, {})).toEqual([]);
  });
});
