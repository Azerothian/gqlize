// Tests for resolving relationships on plain-object rows.
//
// A class or instance method can return plain objects (`{id: 1, name: "x"}`)
// typed as a model. The adapter must resolve relationship fields on them:
// `resolveSingleRelationship` calls `em.populate`, which needs a managed entity;
// `collectionPage` and `countRelationship` read a Collection off the source row,
// which a plain object does not carry. The fix promotes a plain row to a managed
// `getReference` proxy by primary key before those operations.
//
// `asInstance` provides the same promotion for callers that need the row API
// on a plain object — it tags a shallow copy without mutating the original.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { MikroORM } from "@mikro-orm/sqlite";
import { makeOrm } from "./helper/orm";
import type { Article, Author, Tag } from "./helper/entities";

describe("resolving relationships on plain-object rows", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see note in ormize.test.ts
  let db: any;
  let mikro: MikroORM;

  beforeEach(async () => {
    ({ db, mikro } = await makeOrm());
  });
  afterEach(async () => { await mikro.close(true); });

  /** Seed one author with two articles and one tag. */
  async function seed() {
    const author = await db.models.Author.create({ name: "Ada", email: "ada@example.com" });
    const first = await db.models.Article.create({ title: "Alpha", status: "draft", views: 10, authorId: author.id });
    const second = await db.models.Article.create({ title: "Beta", status: "draft", views: 5, authorId: author.id });
    const tag = await db.models.Tag.create({ label: "ops" });
    // Link tag to first article through the m:n relation.
    const article = await db.models.Article.findByPk(first.id);
    await article.addTag(tag);
    // Return plain-object copies — these are what a class method returning literal
    // objects would hand to gqlize after the method runs.
    const plainAuthor = { id: author.id, name: author.name, email: author.email };
    const plainArticle = { id: first.id, title: first.title, status: first.status, views: first.views, authorId: author.id };
    return { author, first, second, tag, plainAuthor, plainArticle };
  }

  it("resolveSingleRelationship: follows a belongsTo on a plain-object source row", async () => {
    const { first, plainArticle } = await seed();
    // Confirm the plain object is not a managed entity.
    expect(plainArticle.constructor).toBe(Object);
    const associations = db.getAssociations("Article");
    // The source row is plain: before the fix, `em.populate(plainArticle, ["author"])`
    // would throw because `plainArticle` is not a managed entity.
    const author = await db.resolveSingleRelationship(
      "Author", associations.author, plainArticle, {}, {},
    );
    expect((author as Author).name).toBe("Ada");
    expect((author as Author).id).toBe(first.authorId ?? (plainArticle as typeof plainArticle & { authorId: number }).authorId);
  });

  it("resolveSingleRelationship: follows a hasOne on a plain-object source row", async () => {
    const { plainArticle, author } = await seed();
    // Set the editor field, then test resolution with a plain article row.
    await db.processUpdate("Article", null, {
      where: { id: { eq: plainArticle.id } }, input: { editorId: author.id },
    }, {});
    mikro.em.clear();
    const associations = db.getAssociations("Article");
    const editor = await db.resolveSingleRelationship(
      "Author", associations.editor, plainArticle, {}, {},
    );
    expect((editor as Author).name).toBe("Ada");
  });

  it("resolveManyRelationship: resolves a hasMany on a plain-object source row (joinFilter path)", async () => {
    const { plainAuthor } = await seed();
    // Author → articles is a 1:m with an inverse (`mappedBy: "author"`) so
    // `joinFilter` finds a path and this exercises the query path with a plain row.
    const page = await db.resolveManyRelationship(
      "Article", db.getAssociations("Author").articles, plainAuthor, {}, {},
    );
    expect(page.total).toBe(2);
    expect(page.models.map((m: Article) => m.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("resolveManyRelationship: resolves a m:n on a plain-object source row (collection fallback path)", async () => {
    // Article → tags is a m:n without a mappedBy on Article's side declared in
    // the test schema's ArticleSchema (Tag has `mappedBy: "tags"` on its articles
    // collection, but Article.tags has `inversedBy: "articles"` — discovery
    // should expose the inverse, but whether it resolves as joinFilter or
    // collectionPage depends on adapter internals). Either path must work for a
    // plain source row.
    const { plainArticle } = await seed();
    const page = await db.resolveManyRelationship(
      "Tag", db.getAssociations("Article").tags, plainArticle, {}, {},
    );
    expect(page.total).toBe(1);
    expect(page.models.map((t: Tag) => t.label)).toEqual(["ops"]);
  });

  it("countRelationship: counts a hasMany on a plain-object source row", async () => {
    const { plainAuthor } = await seed();
    const association = db.getAssociations("Author").articles;
    // countRelationship lives on the adapter, not on the ormize db host.
    const count = await db.getModelAdapter("Author").countRelationship(association, plainAuthor);
    expect(count).toBe(2);
  });

  it("countRelationship: counts a m:n on a plain-object source row", async () => {
    const { plainArticle } = await seed();
    const association = db.getAssociations("Article").tags;
    const count = await db.getModelAdapter("Article").countRelationship(association, plainArticle);
    expect(count).toBe(1);
  });

  it("asInstance: returns a managed entity row unchanged", async () => {
    const { author } = await seed();
    // `author` is already a managed entity tagged by tagRow.
    const result = db.getModelAdapter("Author").asInstance("Author", author);
    // The original object is returned as-is (same reference).
    expect(result).toBe(author);
  });

  it("asInstance: tags a shallow copy of a plain object without mutating the original", async () => {
    const { plainAuthor } = await seed();
    const originalKeys = Object.keys(plainAuthor);
    const tagged = db.getModelAdapter("Author").asInstance("Author", plainAuthor);
    // The copy has the row API.
    expect(typeof tagged.save).toBe("function");
    expect(typeof tagged.get).toBe("function");
    // The original is not mutated — it still has only its own plain keys.
    expect(Object.keys(plainAuthor)).toEqual(originalKeys);
    // The copy is a different object.
    expect(tagged).not.toBe(plainAuthor);
  });
});
