import {graphql} from "graphql";
import type {GraphQLInputObjectType, GraphQLObjectType} from "graphql";
import Sequelize from "sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import {resultData, validateResult} from "./helper";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";

// The PostTag join table carries an extra column but is not exposed in the schema
// (junctions have FK columns without their own associations).
const schemaOpts = {permission: {model: (n: string) => n !== "PostTag"}};

type PostAuthorResult = {models: {Post: {id: string; title: string; author: {name: string} | null}[]}};
type AuthorNameResult = {models: {Author: {id: string; name: string}[]}};
type PostTitleResult = {models: {Post: {id: string; title: string}[]}};

async function build() {
  const db = new Database();
  const {adapter, name, teardown} = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);

  await db.addDefinition({
    name: "Author",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "hasMany", model: "Post", name: "posts", options: {foreignKey: "authorId"}}],
  });
  await db.addDefinition({
    name: "Tag",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsToMany", model: "Post", name: "posts", options: {through: {model: "PostTag"}, foreignKey: "tagId", otherKey: "postId"}}],
  });
  // through model with an extra column
  await db.addDefinition({name: "PostTag", define: {sortOrder: {type: Sequelize.INTEGER, allowNull: true}}});
  // paranoid target (soft delete) for restore
  await db.addDefinition({
    name: "Comment",
    define: {body: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Post", name: "post", options: {foreignKey: "postId"}}],
    options: {paranoid: true},
  });
  await db.addDefinition({
    name: "Post",
    define: {title: {type: Sequelize.STRING, allowNull: false}},
    relationships: [
      {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
      {type: "belongsToMany", model: "Tag", name: "tags", options: {through: {model: "PostTag"}, foreignKey: "postId", otherKey: "tagId"}},
      {type: "hasMany", model: "Comment", name: "comments", options: {foreignKey: "postId"}},
    ],
  });

  await db.initialise();
  await db.sync();
  return db;
}

describe("relationship mutations", () => {
  it("belongsTo: set associates an existing record by filter; remove disassociates", async () => {
    const db = await build();
    const {Author, Post} = db.models;
    const author = await Author.create({name: "author1"});
    const post = await Post.create({title: "post1"});
    const schema = await createSchema(db, schemaOpts);

    const setResult = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { author: { set: { name: { eq: "author1" } } } } }) {
        id title author { name }
      }
    } }`});
    validateResult(setResult);
    const setData = resultData<PostAuthorResult>(setResult);
    expect(setData.models.Post[0].author?.name).toEqual("author1");
    expect((await Post.findByPk(post.get("id"))).get("authorId")).toEqual(author.get("id"));

    const rmResult = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { author: { remove: true } } }) { id author { name } }
    } }`});
    validateResult(rmResult);
    const rmData = resultData<PostAuthorResult>(rmResult);
    expect(rmData.models.Post[0].author).toBeNull();
    expect((await Post.findByPk(post.get("id"))).get("authorId") ?? null).toBeNull();
  });

  it("belongsToMany: add and remove existing records by filter", async () => {
    const db = await build();
    const {Post, Tag} = db.models;
    const post = await Post.create({title: "post1"});
    await Tag.create({name: "tagone"});
    await Tag.create({name: "tagtwo"});
    const schema = await createSchema(db, schemaOpts);

    await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { add: [{ name: { eq: "tagone" } }, { name: { eq: "tagtwo" } }] } } }) { id }
    } }`});
    expect(await post.countTags()).toEqual(2);

    const rm = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { remove: [{ name: { eq: "tagone" } }] } } }) { id }
    } }`});
    validateResult(rm);
    const names = (await post.getTags()).map((t: {get: (key: string) => string}) => t.get("name")).sort();
    expect(names).toEqual(["tagtwo"]);
  });

  it("belongsToMany: set replaces the entire set", async () => {
    const db = await build();
    const {Post, Tag} = db.models;
    const post = await Post.create({title: "post1"});
    const [t1, t2] = await Promise.all([
      Tag.create({name: "tagone"}), Tag.create({name: "tagtwo"}), Tag.create({name: "tagthree"}),
    ]);
    await post.addTags([t1, t2]);
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { set: [{ name: { eq: "tagthree" } }] } } }) { id }
    } }`});
    validateResult(res);
    const names = (await post.getTags()).map((t: {get: (key: string) => string}) => t.get("name"));
    expect(names).toEqual(["tagthree"]);
  });

  it("belongsToMany: add with through attributes writes join-table columns", async () => {
    const db = await build();
    const {Post, Tag, PostTag} = db.models;
    await Post.create({title: "post1"});
    await Tag.create({name: "tagone"});
    const schema = await createSchema(db, {})  // PostTag visible: through mode;

    const res = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { tags: { add: [{ where: { name: { eq: "tagone" } }, through: { sortOrder: 7 } }] } } }) { id }
    } }`});
    validateResult(res);
    const joins = await PostTag.findAll();
    expect(joins).toHaveLength(1);
    expect(joins[0].get("sortOrder")).toEqual(7);
  });

  it("hasMany: set replaces the associated set", async () => {
    const db = await build();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "post1"});
    await Comment.create({body: "commentone", postId: post.get("id")});
    await Comment.create({body: "commenttwo", postId: post.get("id")});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { comments: { set: [{ body: { eq: "commenttwo" } }] } } }) { id }
    } }`});
    validateResult(res);
    const bodies = (await post.getComments()).map((c: {get: (key: string) => string}) => c.get("body"));
    expect(bodies).toEqual(["commenttwo"]);
  });

  it("delete/restore: not offered on a relationship whose target the caller may not delete/restore", async () => {
    const db = await build();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "post1"});
    await Comment.create({body: "commentone", postId: post.get("id")});
    const notComment = (defName: string) => defName !== "Comment";
    const schema = await createSchema(db, {permission: {
      ...schemaOpts.permission, mutationDelete: notComment, mutationRestore: notComment,
    }});

    for (const verb of ["delete", "restore"]) {
      const res = await graphql({schema, source: `mutation { models {
        Post(update: { where: { title: { eq: "post1" } }, input: { comments: { ${verb}: [{ body: { eq: "commentone" } }] } } }) { id }
      } }`});
      expect(res.errors?.[0]?.message).toMatch(new RegExp(`unknown field "${verb}"`));
    }
    expect(await Comment.count()).toEqual(1);
  });

  it("add/set/remove: a to-many relationship offers them only with update permission on its target", async () => {
    const db = await build();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "post1"});
    const other = await Post.create({title: "other"});
    const comment = await Comment.create({body: "c", postId: other.get("id")});
    const notComment = (defName: string) => defName !== "Comment";
    const schema = await createSchema(db, {permission: {...schemaOpts.permission, mutationUpdate: notComment}});
    const fieldsOf = (name: string) => Object.keys((schema.getType(name) as GraphQLInputObjectType).getFields()).sort();
    // `add`/`set`/`remove` on a hasMany rewrite the comment's `postId`: an update of the comment.
    expect(fieldsOf("PostCommentsHasManyInput")).toEqual(["create", "delete", "restore"]);
    // On a belongsTo they write the post's own key, and on a belongsToMany a join row.
    expect(fieldsOf("PostAuthorBelongsToInput")).toEqual(expect.arrayContaining(["set", "remove"]));
    expect(fieldsOf("PostTagsBelongsToManyInput")).toEqual(expect.arrayContaining(["add", "set", "remove"]));

    const res = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { comments: { add: [{ body: { eq: "c" } }] } } }) { id }
    } }`});
    expect(res.errors?.[0]?.message).toMatch(/unknown field "add"/);
    expect((await Comment.findByPk(comment.get("id"))).get("postId")).toEqual(other.get("id"));
    expect(post.get("id")).toBeDefined();
  });

  it("a relationship with every verb denied is left out, not built as an empty input", async () => {
    const db = await build();
    const notComment = (defName: string) => defName !== "Comment";
    const schema = await createSchema(db, {permission: {
      ...schemaOpts.permission,
      mutationCreate: notComment, mutationUpdate: notComment, mutationDelete: notComment, mutationRestore: notComment,
    }});
    const postInput = (schema.getType("PostRequiredInput") as GraphQLInputObjectType).getFields();
    expect(postInput.comments).toBeUndefined();
    expect(postInput.title).toBeDefined();
    expect(schema.getType("PostCommentsHasManyInput")).toBeUndefined();
  });

  it("a model left with nothing writable gets no input at all", async () => {
    const db = await build();
    const notComment = (defName: string) => defName !== "Comment";
    // Post's column and its other relationships are denied too, so nothing on its input remains.
    const schema = await createSchema(db, {permission: {
      ...schemaOpts.permission,
      mutationCreateInput: (defName: string) => defName !== "Post",
      mutationCreate: notComment, mutationUpdate: notComment, mutationDelete: notComment, mutationRestore: notComment,
    }});
    expect(schema.getType("PostRequiredInput")).toBeUndefined();
    const postArgs = (schema.getMutationType()?.getFields().models.type as GraphQLObjectType).getFields().Post.args.map((a) => a.name);
    expect(postArgs).not.toContain("create");
    expect(postArgs).toContain("update");
  });

  it("restore: undeletes soft-deleted (paranoid) related records", async () => {
    const db = await build();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "post1"});
    const comment = await Comment.create({body: "commentone", postId: post.get("id")});
    await comment.destroy(); // soft delete
    expect(await Comment.count()).toEqual(0);
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: { where: { title: { eq: "post1" } }, input: { comments: { restore: [{ body: { eq: "commentone" } }] } } }) { id }
    } }`});
    validateResult(res);
    expect(await Comment.count()).toEqual(1);
  });

  it("select: top-level + nested, relationship-scoped, runs relation mutations without modifying the found rows", async () => {
    const db = await build();
    const {Author, Post, Tag} = db.models;
    const author = await Author.create({name: "author1"});
    const keep = await Post.create({title: "keep", authorId: author.get("id")});
    const other = await Post.create({title: "other", authorId: author.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(select: [{ where: { name: { eq: "author1" } }, input: {
        posts: { select: [{ where: { title: { eq: "keep" } }, input: {
          tags: { add: [{ name: { eq: "t1" } }] }
        } }] }
      } }]) { id name }
    } }`});
    validateResult(res);
    const data = resultData<AuthorNameResult>(res);

    // top-level select returns the found author, unchanged
    expect(data.models.Author.map((a) => a.name)).toEqual(["author1"]);
    // the selected post got the tag; its own title is unchanged
    expect((await keep.getTags()).map((t: {get: (key: string) => string}) => t.get("name"))).toEqual(["t1"]);
    expect((await Post.findByPk(keep.get("id"))).get("title")).toEqual("keep");
    // the non-matching sibling post is untouched
    expect(await other.getTags()).toHaveLength(0);
  });

  it("select: nested select is relationship-scoped (cannot reach unrelated records)", async () => {
    const db = await build();
    const {Author, Post, Tag} = db.models;
    const a1 = await Author.create({name: "a1"});
    const a2 = await Author.create({name: "a2"});
    const p1 = await Post.create({title: "p1", authorId: a1.get("id")});
    const p2 = await Post.create({title: "p2", authorId: a2.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    // a1 tries to select a post titled "p2" — but p2 belongs to a2, so it matches nothing.
    const res = await graphql({schema, source: `mutation { models {
      Author(select: [{ where: { name: { eq: "a1" } }, input: {
        posts: { select: [{ where: { title: { eq: "p2" } }, input: {
          tags: { add: [{ name: { eq: "t1" } }] }
        } }] }
      } }]) { id }
    } }`});
    validateResult(res);
    expect(await p2.getTags()).toHaveLength(0);
    expect(await p1.getTags()).toHaveLength(0);
  });

  it("select: scalar fields in the input are ignored (the selected rows are not modified)", async () => {
    const db = await build();
    const {Post, Tag} = db.models;
    const post = await Post.create({title: "original"});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    // pass BOTH a scalar change (title) and a relationship mutation (tags.add)
    const res = await graphql({schema, source: `mutation { models {
      Post(select: [{ where: { title: { eq: "original" } }, input: {
        title: "HACKED",
        tags: { add: [{ name: { eq: "t1" } }] }
      } }]) { id title }
    } }`});
    validateResult(res);
    const data = resultData<PostTitleResult>(res);

    // the relationship mutation ran...
    expect((await post.getTags()).map((t: {get: (key: string) => string}) => t.get("name"))).toEqual(["t1"]);
    // ...but the scalar `title` was ignored — the selected row is NOT modified
    expect((await Post.findByPk(post.get("id"))).get("title")).toEqual("original");
    expect(data.models.Post.map((p) => p.title)).toEqual(["original"]);
  });

  it("select: singular relationship — selects the related record and runs its relation mutations", async () => {
    const db = await build();
    const {Post, Comment, Tag} = db.models;
    const post = await Post.create({title: "post1"});
    await Comment.create({body: "c1", postId: post.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    // Select the comment (top-level), then select its singular `post`, then tag the post.
    const res = await graphql({schema, source: `mutation { models {
      Comment(select: [{ where: { body: { eq: "c1" } }, input: {
        post: { select: { where: { title: { eq: "post1" } }, input: {
          tags: { add: [{ name: { eq: "t1" } }] }
        } } }
      } }]) { id }
    } }`});
    validateResult(res);
    expect((await post.getTags()).map((t: {get: (key: string) => string}) => t.get("name"))).toEqual(["t1"]);
    expect((await Post.findByPk(post.get("id"))).get("title")).toEqual("post1");
  });
});
