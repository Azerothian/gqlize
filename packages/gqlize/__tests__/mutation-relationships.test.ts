import {graphql} from "graphql";
import Sequelize from "sequelize";
import Database from "../src/manager";
import {createSchema} from "../src/graphql/index";
import {validateResult} from "./helper";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";

// The PostTag join table carries an extra column but is not exposed in the schema
// (junctions have FK columns without their own associations).
const schemaOpts = {permission: {model: (n: string) => n !== "PostTag"}};

async function build() {
  const db = new Database();
  const {adapter, name, teardown} = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);

  db.addDefinition({
    name: "Author",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "hasMany", model: "Post", name: "posts", options: {foreignKey: "authorId"}}],
  } as any);
  db.addDefinition({
    name: "Tag",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsToMany", model: "Post", name: "posts", options: {through: {model: "PostTag"}, foreignKey: "tagId", otherKey: "postId"}}],
  } as any);
  // through model with an extra column
  db.addDefinition({name: "PostTag", define: {sortOrder: {type: Sequelize.INTEGER, allowNull: true}}} as any);
  // paranoid target (soft delete) for restore
  db.addDefinition({
    name: "Comment",
    define: {body: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Post", name: "post", options: {foreignKey: "postId"}}],
    options: {paranoid: true},
  } as any);
  db.addDefinition({
    name: "Post",
    define: {title: {type: Sequelize.STRING, allowNull: false}},
    relationships: [
      {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
      {type: "belongsToMany", model: "Tag", name: "tags", options: {through: {model: "PostTag"}, foreignKey: "postId", otherKey: "tagId"}},
      {type: "hasMany", model: "Comment", name: "comments", options: {foreignKey: "postId"}},
    ],
  } as any);

  await db.initialise();
  await db.sync();
  return db;
}

describe("relationship mutations", () => {
  it("belongsTo: set associates an existing record by filter; remove disassociates", async () => {
    const db = await build();
    const {Author, Post} = db.models as any;
    const author = await Author.create({name: "author1"});
    const post = await Post.create({title: "post1"});
    const schema = await createSchema(db, schemaOpts as any);

    const setRes = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { author: { set: { name: { eq: "author1" } } } } }) {
        id title author { name }
      }
    } }`})) as any;
    validateResult(setRes);
    expect(setRes.data.models.Post[0].author.name).toEqual("author1");
    expect((await Post.findByPk(post.get("id"))).get("authorId")).toEqual(author.get("id"));

    const rmRes = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { author: { remove: true } } }) { id author { name } }
    } }`})) as any;
    validateResult(rmRes);
    expect(rmRes.data.models.Post[0].author).toBeNull();
    expect((await Post.findByPk(post.get("id"))).get("authorId") ?? null).toBeNull();
  });

  it("belongsToMany: add and remove existing records by filter", async () => {
    const db = await build();
    const {Post, Tag} = db.models as any;
    const post = await Post.create({title: "post1"});
    await Tag.create({name: "tagone"});
    await Tag.create({name: "tagtwo"});
    const schema = await createSchema(db, schemaOpts as any);

    await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { add: [{ where: { name: { eq: "tagone" } } }, { where: { name: { eq: "tagtwo" } } }] } } }) { id }
    } }`});
    expect(await (post as any).countTags()).toEqual(2);

    const rm = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { remove: [{ name: { eq: "tagone" } }] } } }) { id }
    } }`})) as any;
    validateResult(rm);
    const names = (await (post as any).getTags()).map((t: any) => t.get("name")).sort();
    expect(names).toEqual(["tagtwo"]);
  });

  it("belongsToMany: set replaces the entire set", async () => {
    const db = await build();
    const {Post, Tag} = db.models as any;
    const post = await Post.create({title: "post1"});
    const [t1, t2, t3] = await Promise.all([
      Tag.create({name: "tagone"}), Tag.create({name: "tagtwo"}), Tag.create({name: "tagthree"}),
    ]);
    await (post as any).addTags([t1, t2]);
    const schema = await createSchema(db, schemaOpts as any);

    const res = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { set: [{ where: { name: { eq: "tagthree" } } }] } } }) { id }
    } }`})) as any;
    validateResult(res);
    const names = (await (post as any).getTags()).map((t: any) => t.get("name"));
    expect(names).toEqual(["tagthree"]);
  });

  it("belongsToMany: add with through attributes writes join-table columns", async () => {
    const db = await build();
    const {Post, Tag, PostTag} = db.models as any;
    const post = await Post.create({title: "post1"});
    await Tag.create({name: "tagone"});
    const schema = await createSchema(db, schemaOpts as any);

    const res = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { add: [{ where: { name: { eq: "tagone" } }, through: { sortOrder: 7 } }] } } }) { id }
    } }`})) as any;
    validateResult(res);
    const joins = await PostTag.findAll();
    expect(joins).toHaveLength(1);
    expect(joins[0].get("sortOrder")).toEqual(7);
  });

  it("hasMany: set replaces the associated set", async () => {
    const db = await build();
    const {Post, Comment} = db.models as any;
    const post = await Post.create({title: "post1"});
    await Comment.create({body: "commentone", postId: post.get("id")});
    await Comment.create({body: "commenttwo", postId: post.get("id")});
    const schema = await createSchema(db, schemaOpts as any);

    const res = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { comments: { set: [{ body: { eq: "commenttwo" } }] } } }) { id }
    } }`})) as any;
    validateResult(res);
    const bodies = (await (post as any).getComments()).map((c: any) => c.get("body"));
    expect(bodies).toEqual(["commenttwo"]);
  });

  it("restore: undeletes soft-deleted (paranoid) related records", async () => {
    const db = await build();
    const {Post, Comment} = db.models as any;
    const post = await Post.create({title: "post1"});
    const comment = await Comment.create({body: "commentone", postId: post.get("id")});
    await comment.destroy(); // soft delete
    expect(await Comment.count()).toEqual(0);
    const schema = await createSchema(db, schemaOpts as any);

    const res = (await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { comments: { restore: [{ body: { eq: "commentone" } }] } } }) { id }
    } }`})) as any;
    validateResult(res);
    expect(await Comment.count()).toEqual(1);
  });

  it("select: top-level + nested, relationship-scoped, runs relation mutations without modifying the found rows", async () => {
    const db = await build();
    const {Author, Post, Tag} = db.models as any;
    const author = await Author.create({name: "author1"});
    const keep = await Post.create({title: "keep", authorId: author.get("id")});
    const other = await Post.create({title: "other", authorId: author.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts as any);

    const res = (await graphql({schema, source: `mutation { models {
      Author(select: [{ where: { name: { eq: "author1" } }, input: {
        posts: { select: [{ where: { title: { eq: "keep" } }, input: {
          tags: { add: [{ where: { name: { eq: "t1" } } }] }
        } }] }
      } }]) { id name }
    } }`})) as any;
    validateResult(res);

    // top-level select returns the found author, unchanged
    expect(res.data.models.Author.map((a: any) => a.name)).toEqual(["author1"]);
    // the selected post got the tag; its own title is unchanged
    expect((await (keep as any).getTags()).map((t: any) => t.get("name"))).toEqual(["t1"]);
    expect((await Post.findByPk(keep.get("id"))).get("title")).toEqual("keep");
    // the non-matching sibling post is untouched
    expect(await (other as any).getTags()).toHaveLength(0);
  });

  it("select: nested select is relationship-scoped (cannot reach unrelated records)", async () => {
    const db = await build();
    const {Author, Post, Tag} = db.models as any;
    const a1 = await Author.create({name: "a1"});
    const a2 = await Author.create({name: "a2"});
    const p1 = await Post.create({title: "p1", authorId: a1.get("id")});
    const p2 = await Post.create({title: "p2", authorId: a2.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts as any);

    // a1 tries to select a post titled "p2" — but p2 belongs to a2, so it matches nothing.
    const res = (await graphql({schema, source: `mutation { models {
      Author(select: [{ where: { name: { eq: "a1" } }, input: {
        posts: { select: [{ where: { title: { eq: "p2" } }, input: {
          tags: { add: [{ where: { name: { eq: "t1" } } }] }
        } }] }
      } }]) { id }
    } }`})) as any;
    validateResult(res);
    expect(await (p2 as any).getTags()).toHaveLength(0);
    expect(await (p1 as any).getTags()).toHaveLength(0);
  });

  it("select: scalar fields in the input are ignored (the selected rows are not modified)", async () => {
    const db = await build();
    const {Post, Tag} = db.models as any;
    const post = await Post.create({title: "original"});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts as any);

    // pass BOTH a scalar change (title) and a relationship mutation (tags.add)
    const res = (await graphql({schema, source: `mutation { models {
      Post(select: [{ where: { title: { eq: "original" } }, input: {
        title: "HACKED",
        tags: { add: [{ where: { name: { eq: "t1" } } }] }
      } }]) { id title }
    } }`})) as any;
    validateResult(res);

    // the relationship mutation ran...
    expect((await (post as any).getTags()).map((t: any) => t.get("name"))).toEqual(["t1"]);
    // ...but the scalar `title` was ignored — the selected row is NOT modified
    expect((await Post.findByPk(post.get("id"))).get("title")).toEqual("original");
    expect(res.data.models.Post.map((p: any) => p.title)).toEqual(["original"]);
  });

  it("select: singular relationship — selects the related record and runs its relation mutations", async () => {
    const db = await build();
    const {Post, Comment, Tag} = db.models as any;
    const post = await Post.create({title: "post1"});
    await Comment.create({body: "c1", postId: post.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts as any);

    // Select the comment (top-level), then select its singular `post`, then tag the post.
    const res = (await graphql({schema, source: `mutation { models {
      Comment(select: [{ where: { body: { eq: "c1" } }, input: {
        post: { select: { where: { title: { eq: "post1" } }, input: {
          tags: { add: [{ where: { name: { eq: "t1" } } }] }
        } } }
      } }]) { id }
    } }`})) as any;
    validateResult(res);
    expect((await (post as any).getTags()).map((t: any) => t.get("name"))).toEqual(["t1"]);
    expect((await Post.findByPk(post.get("id"))).get("title")).toEqual("post1");
  });
});
