import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { graphql, printSchema, type GraphQLSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import type { MikroORM } from "@mikro-orm/sqlite";
import { makeOrm } from "./helper/orm";

describe("a GraphQL schema over the discovered models", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the note in ormize.test.ts
  let db: any;
  let mikro: MikroORM;
  let schema: GraphQLSchema;

  beforeEach(async () => {
    ({ db, mikro } = await makeOrm());
    schema = await createSchema(db);
  });
  afterEach(async () => { await mikro.close(true); });

  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({ schema, source, variableValues });
    if (result.errors) {
      throw result.errors[0];
    }
    return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  async function seed() {
    const author = await db.models.Author.create({ name: "Ada", email: "ada@example.com" });
    await db.models.Article.create({ title: "Alpha", status: "draft", views: 10, authorId: author.id });
    await db.models.Article.create({ title: "Beta", status: "in-progress", views: 5, authorId: author.id });
    return { author };
  }

  it("puts every discovered model on the root query", () => {
    const sdl = printSchema(schema);
    expect(sdl).toMatch(/type QueryModels/);
    for (const name of ["Author", "Article", "Tag"]) {
      expect(sdl).toContain(`  ${name}(`);
    }
  });

  it("names an enum column's type and sanitises its members", () => {
    const type = schema.getType("ArticleStatusEnum");
    expect(type).toBeDefined();
    // `in-progress` and `2xl` are not valid GraphQL names; the shared
    // `createEnumType` sanitises them, and the backend values are untouched.
    const values = (type as any).getValues(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(values.map((v: { name: string }) => v.name)).toEqual(["draft", "inProgress", "_2xl"]);
    expect(values.map((v: { value: string }) => v.value)).toEqual(["draft", "in-progress", "2xl"]);
  });

  it("keeps a column the entity computes out of the create input", () => {
    const sdl = printSchema(schema);
    const input = sdl.slice(sdl.indexOf("input GQLTAuthorCreateInput"));
    expect(input.slice(0, input.indexOf("}"))).not.toMatch(/createdAt|\bid\b/);
  });

  it("generates where, orderBy and include arguments", () => {
    const sdl = printSchema(schema);
    expect(sdl).toContain("input GQLTQueryArticleWhere ");
    expect(sdl).toContain("enum ArticleOrderBy");
    // One include object keyed by relationship name, not a list: MikroORM
    // populates by path, once per path, so there is no alias to repeat a join
    // under. The name reflects it — a list adapter generates `…IncludeObject`.
    expect(sdl).toContain("input GQLTArticleInclude ");
    expect(sdl).not.toContain("input GQLTArticleIncludeObject ");
    expect(sdl).toMatch(/include: GQLTArticleInclude\b/);
  });

  it("reads a list with filter, ordering and paging", async () => {
    await seed();
    const data = await run(`{
      models { Article(where: {views: {gte: 1}}, orderBy: [viewsDESC], first: 1) {
        total edges { node { title views } }
      } }
    }`);
    expect(data.models.Article.total).toBe(2);
    expect(data.models.Article.edges.map((e: any) => e.node.title)).toEqual(["Alpha"]); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("walks a relationship in both directions", async () => {
    await seed();
    const data = await run(`{
      models { Author { edges { node {
        name
        articles(orderBy: [titleASC]) { total edges { node { title author { name } } } }
      } } } }
    }`);
    const author = data.models.Author.edges[0].node;
    expect(author.articles.total).toBe(2);
    expect(author.articles.edges.map((e: any) => e.node.title)).toEqual(["Alpha", "Beta"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(author.articles.edges[0].node.author.name).toBe("Ada");
  });

  it("mints a foreign key as its target's global id, and round-trips it", async () => {
    const { author } = await seed();
    // This is the #65 behaviour the synthesized foreign key exists to serve:
    // `Article.authorId` holds an Author key, so its global id is an Author id.
    const data = await run(`{
      models { Article(first: 1, orderBy: [titleASC]) { edges { node { id authorId } } } }
      authors: models { Author { edges { node { id } } } }
    }`);
    const article = data.models.Article.edges[0].node;
    const authorId = data.authors.Author.edges.find((e: any) => e.node)!.node.id; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(article.authorId).toBe(authorId);
    expect(article.authorId).not.toBe(article.id);

    // And it decodes back to the raw key on the way in.
    const filtered = await run(`query ($id: ID!) {
      models { Article(where: {authorId: {eq: $id}}) { total } }
    }`, { id: article.authorId });
    expect(filtered.models.Article.total).toBe(2);
    expect(author.id).toBeGreaterThan(0);
  });

  it("refuses a global id minted for another type", async () => {
    await seed();
    const data = await run(`{ models { Article(first: 1) { edges { node { id } } } } }`);
    const articleId = data.models.Article.edges[0].node.id;
    await expect(run(`query ($id: ID!) {
      models { Article(where: {authorId: {eq: $id}}) { total } }
    }`, { id: articleId })).rejects.toThrow(/expects a "Author" id/);
  });

  it("resolves a node by its global id", async () => {
    await seed();
    const data = await run(`{ models { Article(first: 1, orderBy: [titleASC]) { edges { node { id } } } } }`);
    const id = data.models.Article.edges[0].node.id;
    const node = await run(`query ($id: ID!) { node(id: $id) { ... on Article { title } } }`, { id });
    expect(node.node.title).toBe("Alpha");
  });

  it("creates and updates through the generated mutations", async () => {
    const created = await run(`mutation {
      models { Author(create: [{name: "Grace", email: "grace@example.com"}]) { id name } }
    }`);
    expect(created.models.Author[0].name).toBe("Grace");

    const updated = await run(`mutation ($id: ID!) {
      models { Author(update: [{where: {id: {eq: $id}}, input: {name: "Grace H"}}]) { name } }
    }`, { id: created.models.Author[0].id });
    expect(updated.models.Author[0].name).toBe("Grace H");
  });

  it("pages with cursors", async () => {
    await seed();
    const first = await run(`{
      models { Article(orderBy: [titleASC], first: 1) {
        total edges { cursor node { title } } pageInfo { hasNextPage hasPreviousPage }
      } }
    }`);
    expect(first.models.Article.pageInfo).toEqual({ hasNextPage: true, hasPreviousPage: false });
    const cursor = first.models.Article.edges[0].cursor;
    const next = await run(`query ($after: String) {
      models { Article(orderBy: [titleASC], first: 1, after: $after) {
        edges { node { title } } pageInfo { hasNextPage hasPreviousPage }
      } }
    }`, { after: cursor });
    expect(next.models.Article.edges[0].node.title).toBe("Beta");
    expect(next.models.Article.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: true });
  });

  it("eager-loads through the include argument", async () => {
    await seed();
    const data = await run(`{
      models { Article(include: {author: {}}, orderBy: [titleASC]) {
        edges { node { title author { name } } }
      } }
    }`);
    expect(data.models.Article.edges.map((e: any) => e.node.author.name)).toEqual(["Ada", "Ada"]); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("makes a required include filter the total as well as the page", async () => {
    const { author } = await seed();
    // Only this one has an editor; `editor` is the nullable relation, so the
    // other two have none. `required` is an inner join, so they have to drop out
    // of both halves — a `total` that disagreed with the page would page wrongly
    // at every cursor.
    await db.models.Article.create({
      title: "Edited", status: "draft", authorId: author.id, editorId: author.id,
    });

    const all = await run(`{ models { Article { total } } }`);
    expect(all.models.Article.total).toBe(3);

    const required = await run(`{
      models { Article(include: {editor: {required: true}}, orderBy: [titleASC]) {
        total edges { node { title } }
      } }
    }`);
    expect(required.models.Article.total).toBe(1);
    expect(required.models.Article.edges.map((e: any) => e.node.title)).toEqual(["Edited"]); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
