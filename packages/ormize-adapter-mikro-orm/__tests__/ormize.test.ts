import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { MikroORM } from "@mikro-orm/sqlite";
import { makeOrm } from "./helper/orm";
import type { Article, Author, Tag } from "./helper/entities";

describe("the adapter driven through ormize", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the ormize instance is typed by the adapter's entity map, which these suites deliberately do not supply; the type-level assertions live in __tests__/types
  let db: any;
  let mikro: MikroORM;

  beforeEach(async () => {
    ({ db, mikro } = await makeOrm());
  });
  afterEach(async () => { await mikro.close(true); });

  async function seed() {
    const author = await db.models.Author.create({ name: "Ada", email: "ada@example.com", rank: 1 });
    const other = await db.models.Author.create({ name: "Grace", email: "grace@example.com", rank: 2 });
    const first = await db.models.Article.create({ title: "Alpha", status: "draft", views: 10, authorId: author.id });
    const second = await db.models.Article.create({ title: "Beta", status: "draft", views: 5, authorId: author.id });
    const third = await db.models.Article.create({ title: "Gamma", status: "2xl", views: 1, authorId: other.id });
    return { author, other, first, second, third };
  }

  it("registers every model with no define() call", () => {
    expect(Object.keys(db.getDefinitions()).sort()).toEqual(["Article", "Author", "Tag"]);
    expect(db.models.Author).toBeDefined();
    expect(db.getModelAdapter("Article").adapterName).toBe("mikro-orm");
  });

  it("creates and reads rows through the model statics", async () => {
    const author = await db.models.Author.create({ name: "Ada" });
    expect(author.id).toBeGreaterThan(0);
    expect(await db.models.Author.count()).toBe(1);
    expect((await db.models.Author.findByPk(author.id)).name).toBe("Ada");
  });

  it("applies a default the entity declared but the input omitted", async () => {
    const author = await db.models.Author.create({ name: "Ada" });
    expect(author.rank).toBe(0);
    expect(author.active).toBe(true);
  });

  it("filters, orders and pages a root read", async () => {
    await seed();
    const page = await db.resolveFindAll("Article", null, {
      where: { status: { eq: "draft" } },
      orderBy: [["views", "DESC"]],
      first: 1,
    }, {});
    expect(page.total).toBe(2);
    expect(page.models.map((m: Article) => m.title)).toEqual(["Alpha"]);
  });

  it("filters on a synthesized foreign key", async () => {
    const { author } = await seed();
    const page = await db.resolveFindAll("Article", null, { where: { authorId: { eq: author.id } } }, {});
    expect(page.total).toBe(2);
  });

  it("reads a foreign key off a row without loading the relation", async () => {
    const { author, first } = await seed();
    // The identity map still holds the seeded Author, which would make the
    // reference look loaded for a reason that has nothing to do with the read.
    mikro.em.clear();
    const row = await db.models.Article.findByPk(first.id);
    expect(row.author.isInitialized()).toBe(false);
    expect(db.getValueFromInstance("Article", row, "authorId")).toBe(author.id);
    // Still not loaded: the key was already on the reference.
    expect(row.author.isInitialized()).toBe(false);
  });

  it("fully loads a relation declared without a reference wrapper", async () => {
    const { author, first } = await seed();
    await db.processUpdate("Article", null, { where: { id: { eq: first.id } }, input: { editorId: author.id } }, {});
    // A fresh identity map, so the relation really is unloaded when it is read.
    mikro.em.clear();
    const row = await db.models.Article.findByPk(first.id);
    const editor = await db.resolveSingleRelationship("Author", db.getAssociations("Article").editor, row, {}, {});
    expect((editor as Author).name).toBe("Ada");
  });

  it("resolves a belongsTo and a hasMany", async () => {
    const { author, first } = await seed();
    const associations = db.getAssociations("Article");
    const single = await db.resolveSingleRelationship("Author", associations.author, first, {}, {});
    expect((single as Author).name).toBe("Ada");

    const many = await db.resolveManyRelationship("Article", db.getAssociations("Author").articles, author, {}, {});
    expect(many.total).toBe(2);
    expect(many.models.map((m: Article) => m.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("filters and pages a hasMany", async () => {
    const { author } = await seed();
    const page = await db.resolveManyRelationship("Article", db.getAssociations("Author").articles, author, {
      where: { title: { eq: "Beta" } },
    }, {});
    expect(page.total).toBe(1);
    expect(page.models[0].title).toBe("Beta");
  });

  it("runs the mutation verbs", async () => {
    const [author] = await db.processCreate("Author", null, { input: { name: "Ada", rank: 3 } }, {});
    expect(author.name).toBe("Ada");

    const updated = await db.processUpdate("Author", null, { where: { id: { eq: author.id } }, input: { rank: 9 } }, {});
    expect(updated[0].rank).toBe(9);

    const selected = await db.processSelect("Author", null, { where: { rank: { eq: 9 } } }, {});
    expect(selected).toHaveLength(1);

    const deleted = await db.processDelete("Author", null, { id: { eq: author.id } }, {});
    expect(deleted).toHaveLength(1);
    expect(await db.models.Author.count()).toBe(0);
  });

  it("reports a column the entity computes as non-writable", () => {
    // `createdAt` has an `onCreate` and `id` is generated, so MikroORM writes
    // both itself. Marking them here is what keeps them out of the generated
    // create/update inputs (`isInputFieldWritable`), so a client is never
    // offered a field whose value would be overwritten.
    const fields = db.getFields("Author");
    expect(fields.createdAt.writable).toBe(false);
    expect(fields.id.writable).toBe(false);
    expect(fields.name.writable).toBe(true);
  });

  it("runs a nested relationship mutation", async () => {
    const { author, third } = await seed();
    // A collection that is not a `belongsToMany` takes the filter directly.
    await db.processRelationshipMutation("Author", author, {
      articles: { add: [{ id: { eq: third.id } }] },
    }, {});
    const page = await db.resolveManyRelationship("Article", db.getAssociations("Author").articles, author, {}, {});
    expect(page.total).toBe(3);
  });

  it("links a many-to-many through the shared accessor names", async () => {
    const { first } = await seed();
    const tag = await db.models.Tag.create({ label: "ops" });
    const article = await db.models.Article.findByPk(first.id);
    await article.addTag(tag);
    const page = await db.resolveManyRelationship("Tag", db.getAssociations("Article").tags, article, {}, {});
    expect(page.models.map((t: Tag) => t.label)).toEqual(["ops"]);

    await article.removeTag(tag);
    expect(await db.resolveManyRelationship("Tag", db.getAssociations("Article").tags, article, {}, {})).toMatchObject({ total: 0 });
  });

  it("rolls a transaction back", async () => {
    await expect(db.transaction(async () => {
      await db.processCreate("Author", null, { input: { name: "Ada" } }, {});
      throw new Error("nope");
    })).rejects.toThrow("nope");
    expect(await db.models.Author.count()).toBe(0);
  });

  it("commits a transaction", async () => {
    await db.transaction(async () => {
      await db.processCreate("Author", null, { input: { name: "Ada" } }, {});
    });
    expect(await db.models.Author.count()).toBe(1);
  });
});
