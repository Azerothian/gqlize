import { describe, it, expect, afterEach } from "@jest/globals";
import MikroAdapter from "../src/index";
import { makeMikro } from "./helper/orm";

describe("discovery", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function discover(options = {}) {
    const mikro = await makeMikro();
    close = () => mikro.close(true);
    const adapter = new MikroAdapter(mikro, options);
    const defs = adapter.discoverDefinitions();
    return { adapter, defs, byName: Object.fromEntries(defs.map((d) => [d.name as string, d])) };
  }

  it("registers every entity without a single define() call", async () => {
    const { byName } = await discover();
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(["Author", "Article", "Tag"]));
  });

  it("derives scalar columns with their nullability, defaults and comments", async () => {
    const { byName } = await discover();
    const article = byName.Article.define!;
    expect(article.title).toMatchObject({ allowNull: false, description: "Headline" });
    expect(article.body).toMatchObject({ allowNull: true });
    expect(article.views).toMatchObject({ defaultValue: 0 });
    expect(byName.Author.define!.email).toMatchObject({ unique: true, allowNull: true });
  });

  it("marks a generated primary key non-writable and a plain column writable", async () => {
    const { byName } = await discover();
    expect(byName.Author.define!.id).toMatchObject({ primaryKey: true, autoPopulated: true, writable: false });
    expect(byName.Author.define!.name).toMatchObject({ writable: true });
    // `onCreate` writes the value itself, so accepting one from a mutation input
    // would take it and throw it away.
    expect(byName.Author.define!.createdAt).toMatchObject({ autoPopulated: true, writable: false });
  });

  it("synthesizes a foreign key typed by what it points at", async () => {
    const { byName } = await discover();
    // MikroORM has no scalar property for `Article.author`'s key; this is the one
    // discovery invents, and `foreignTarget` is what mints its global id as an
    // Author id rather than an Article one (#65).
    expect(byName.Article.define!.authorId).toMatchObject({
      foreignKey: true, foreignTarget: "Author", writable: true,
    });
    expect(byName.Article.define!.author).toBeUndefined();
  });

  it("maps each reference kind to its ormize relationship", async () => {
    const { byName } = await discover();
    const article = byName.Article.relationships!;
    const author = byName.Author.relationships!;
    expect(article.find((r) => r.name === "author")).toMatchObject({
      type: "belongsTo", model: "Author", options: { foreignKey: "authorId", targetKey: "id" },
    });
    expect(author.find((r) => r.name === "articles")).toMatchObject({
      type: "hasMany", model: "Article", options: { foreignKey: "authorId", sourceKey: "id" },
    });
    expect(article.find((r) => r.name === "tags")).toMatchObject({
      type: "belongsToMany", model: "Tag",
    });
  });

  it("leaves MikroORM's auto-generated pivot out of the model list", async () => {
    const { defs, byName } = await discover();
    // It has a composite primary key and no identity beyond the pair it joins,
    // and nothing needs it: the relationship is walked through MikroORM's own
    // Collection. Registering it would put a two-column key through an engine
    // that reads `getPrimaryKeyNameForModel(...)[0]`.
    expect(defs.every((d) => !/article_tags|tags_article/i.test(d.name as string))).toBe(true);
    expect(Object.keys(byName).sort()).toEqual(["Article", "Author", "Tag"]);
    // The relationship survives it.
    expect(byName.Article.relationships!.find((r) => r.name === "tags")).toMatchObject({
      type: "belongsToMany", model: "Tag",
    });
  });

  it("merges per-entity overrides over the derived definition rather than replacing it", async () => {
    const { byName } = await discover({
      definitions: {
        Author: {
          comment: "People who write",
          ignoreFields: ["rank"],
          define: { name: { type: "string", description: "Display name" } },
        },
      },
    });
    const author = byName.Author;
    expect(author.comment).toBe("People who write");
    expect(author.ignoreFields).toContain("rank");
    expect(author.define!.name).toMatchObject({ description: "Display name" });
    // The other forty columns are still there.
    expect(author.define!.email).toBeDefined();
    expect(author.define!.createdAt).toBeDefined();
  });

  it("limits discovery to the named entities, pivots aside", async () => {
    const { byName } = await discover({ entities: ["Author"] });
    expect(byName.Author).toBeDefined();
    expect(byName.Article).toBeUndefined();
  });
});
