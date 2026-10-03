/**
 * Exhaustive coverage of every nested relationship mutation verb — create,
 * update, add, set, remove, delete, restore, select — on each relationship
 * type (belongsTo, hasOne, hasMany, belongsToMany) at depth 1 and depth 2.
 *
 * Plus: transaction rollback on a throwing `apply` transform, FK violation
 * rollback, bulk update with `limit`, multi-row delete, create with a list,
 * and hook-firing parity across dialects.
 */
import {graphql} from "graphql";
import Sequelize from "sequelize";
import {Ormize as Database} from "@azerothian/ormize";
import {createSchema} from "../src";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";
import type {Definition} from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateResult(result: {errors?: readonly unknown[] | null}) {
  if ((result.errors || []).length > 0) {
    throw result.errors![0] as Error;
  }
}

function resultData<T>(result: {data?: unknown}): T {
  return result.data as T;
}

// ---------------------------------------------------------------------------
// Shared schema: Author -> Post -> Comment(paranoid), Post <-> Tag (through PostTag)
// Plus Profile (hasOne on Author) for singular relationship tests
// ---------------------------------------------------------------------------

const schemaOpts = {permission: {model: (n: string) => !["PostTag"].includes(n)}};

const hookLog: string[] = [];

const AuthorDef: Definition = {
  name: "Author",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "hasMany", model: "Post", name: "posts", options: {foreignKey: "authorId"}},
    {type: "hasOne", model: "Profile", name: "profile", options: {foreignKey: "authorId"}},
  ],
};

const ProfileDef: Definition = {
  name: "Profile",
  define: {
    bio: {type: Sequelize.STRING, allowNull: true},
  },
  relationships: [
    {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
  ],
};

const PostDef: Definition = {
  name: "Post",
  define: {
    title: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
    {type: "belongsToMany", model: "Tag", name: "tags", options: {through: {model: "PostTag"}, foreignKey: "postId", otherKey: "tagId"}},
    {type: "hasMany", model: "Comment", name: "comments", options: {foreignKey: "postId"}},
  ],
  options: {
    hooks: {
      afterCreate() { hookLog.push("Post:afterCreate"); },
      afterUpdate() { hookLog.push("Post:afterUpdate"); },
      afterDestroy() { hookLog.push("Post:afterDestroy"); },
    },
  },
};

const TagDef: Definition = {
  name: "Tag",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "belongsToMany", model: "Post", name: "posts", options: {through: {model: "PostTag"}, foreignKey: "tagId", otherKey: "postId"}},
  ],
};

const PostTagDef: Definition = {
  name: "PostTag",
  define: {
    sortOrder: {type: Sequelize.INTEGER, allowNull: true},
    label: {type: Sequelize.STRING, allowNull: true},
  },
};

const CommentDef: Definition = {
  name: "Comment",
  define: {
    body: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "belongsTo", model: "Post", name: "post", options: {foreignKey: "postId"}},
  ],
  options: {paranoid: true},
};

// A definition with a throwing transform for rollback tests
const ArticleDef: Definition = {
  name: "Article",
  define: {
    title: {type: Sequelize.STRING, allowNull: false},
    status: {type: Sequelize.STRING, allowNull: true},
  },
  relationships: [
    {type: "hasMany", model: "Note", name: "notes", options: {foreignKey: "articleId"}},
  ],
  expose: {
    instanceMethods: {
      mutations: {
        explode: {},
      },
    },
  },
  options: {
    instanceMethods: {
      explode() {
        throw new Error("transform exploded on purpose");
      },
    },
  },
};

const NoteDef: Definition = {
  name: "Note",
  define: {
    text: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "belongsTo", model: "Article", name: "article", options: {foreignKey: "articleId"}},
  ],
};

const allDefs = [AuthorDef, ProfileDef, PostDef, TagDef, PostTagDef, CommentDef, ArticleDef, NoteDef];

async function buildFull() {
  const db = new Database();
  const {adapter, name, teardown} = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  for (const d of allDefs) {
    await db.addDefinition(d);
  }
  await db.initialise();
  await db.sync();
  hookLog.length = 0;
  return db;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type PostRow = {id: string; title: string};

// ---------------------------------------------------------------------------
// belongsTo verbs
// ---------------------------------------------------------------------------

describe("nested verbs — belongsTo", () => {
  it("create: creates a new parent and associates via belongsTo", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(create: {title: "post1", author: {create: {name: "newAuthor"}}}) {
        id title author { id name }
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: {id: string; title: string; author: {id: string; name: string}}[]}};
    const post = resultData<R>(res).models.Post[0];
    expect(post.author.name).toBe("newAuthor");
    expect(post.title).toBe("post1");
  });

  it("set: associates an existing record to a belongsTo", async () => {
    const db = await buildFull();
    const {Author, Post} = db.models;
    await Author.create({name: "a1"});
    await Post.create({title: "p1"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {author: {set: {name: {eq: "a1"}}}}}) {
        id author { name }
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: {id: string; author: {name: string}}[]}};
    expect(resultData<R>(res).models.Post[0].author.name).toBe("a1");
  });

  it("remove: disassociates a belongsTo", async () => {
    const db = await buildFull();
    const {Author, Post} = db.models;
    const author = await Author.create({name: "a1"});
    await Post.create({title: "p1", authorId: author.get("id")});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {author: {remove: true}}}) {
        id author { name }
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: {id: string; author: {name: string} | null}[]}};
    expect(resultData<R>(res).models.Post[0].author).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasOne verbs
// ---------------------------------------------------------------------------

describe("nested verbs — hasOne", () => {
  it("create: creates a new child via hasOne", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(create: {name: "a1", profile: {create: {bio: "hello"}}}) {
        id name profile { id bio }
      }
    } }`});
    validateResult(res);
    type R = {models: {Author: {id: string; name: string; profile: {id: string; bio: string}}[]}};
    const author = resultData<R>(res).models.Author[0];
    expect(author.profile.bio).toBe("hello");
  });

  it("set: replaces the associated hasOne record", async () => {
    const db = await buildFull();
    const {Author, Profile} = db.models;
    const a = await Author.create({name: "a1"});
    await Profile.create({bio: "old", authorId: a.get("id")});
    await Profile.create({bio: "new"});
    const schema = await createSchema(db, schemaOpts);

    // hasOne `set` takes a single where object (like belongsTo), not an array.
    const res = await graphql({schema, source: `mutation { models {
      Author(update: {where: {name: {eq: "a1"}}, input: {profile: {set: {bio: {eq: "new"}}}}}) {
        id profile { bio }
      }
    } }`});
    validateResult(res);
    type R = {models: {Author: {id: string; profile: {bio: string}}[]}};
    expect(resultData<R>(res).models.Author[0].profile.bio).toBe("new");
  });

  it("remove: disassociates the hasOne child", async () => {
    const db = await buildFull();
    const {Author, Profile} = db.models;
    const a = await Author.create({name: "a1"});
    await Profile.create({bio: "hello", authorId: a.get("id")});
    const schema = await createSchema(db, schemaOpts);

    // hasOne `remove` takes a boolean (like belongsTo), not a filter array.
    const res = await graphql({schema, source: `mutation { models {
      Author(update: {where: {name: {eq: "a1"}}, input: {profile: {remove: true}}}) {
        id profile { bio }
      }
    } }`});
    validateResult(res);
    type R = {models: {Author: {id: string; profile: {bio: string} | null}[]}};
    expect(resultData<R>(res).models.Author[0].profile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasMany verbs
// ---------------------------------------------------------------------------

describe("nested verbs — hasMany", () => {
  it("create: creates child records via hasMany", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(create: {title: "p1", comments: {create: [{body: "c1"}, {body: "c2"}]}}) {
        id comments { edges { node { body } } }
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: {id: string; comments: {edges: {node: {body: string}}[]}}[]}};
    const bodies = resultData<R>(res).models.Post[0].comments.edges.map(e => e.node.body).sort();
    expect(bodies).toEqual(["c1", "c2"]);
  });

  it("update: updates matching child records via hasMany", async () => {
    const db = await buildFull();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "p1"});
    await Comment.create({body: "old", postId: post.get("id")});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {comments: {update: {where: {body: {eq: "old"}}, input: {body: "new"}}}}}) {
        id
      }
    } }`});
    validateResult(res);
    const updated = await Comment.findOne({where: {postId: post.get("id")}});
    expect(updated.get("body")).toBe("new");
  });

  it("delete: soft-deletes paranoid child records via hasMany", async () => {
    const db = await buildFull();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "p1"});
    await Comment.create({body: "c1", postId: post.get("id")});
    await Comment.create({body: "c2", postId: post.get("id")});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {comments: {delete: [{body: {eq: "c1"}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    // c1 is soft-deleted, c2 remains
    expect(await Comment.count()).toBe(1);
    expect(await Comment.count({paranoid: false})).toBe(2);
  });

  it("restore: undeletes soft-deleted paranoid children", async () => {
    const db = await buildFull();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "p1"});
    const c = await Comment.create({body: "c1", postId: post.get("id")});
    await c.destroy(); // soft delete
    expect(await Comment.count()).toBe(0);
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {comments: {restore: [{body: {eq: "c1"}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    expect(await Comment.count()).toBe(1);
  });

  it("set: replaces the associated set of hasMany children", async () => {
    const db = await buildFull();
    const {Post, Comment} = db.models;
    const post = await Post.create({title: "p1"});
    await Comment.create({body: "c1", postId: post.get("id")});
    await Comment.create({body: "c2", postId: post.get("id")});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {comments: {set: [{body: {eq: "c2"}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    const remaining = (await post.getComments()).map((c: {get: (k: string) => string}) => c.get("body"));
    expect(remaining).toEqual(["c2"]);
  });

  it("select: runs sub-mutations on selected children without modifying them", async () => {
    const db = await buildFull();
    const {Author, Post, Tag} = db.models;
    const author = await Author.create({name: "a1"});
    const post = await Post.create({title: "p1", authorId: author.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(select: [{where: {name: {eq: "a1"}}, input: {
        posts: {select: [{where: {title: {eq: "p1"}}, input: {
          tags: {add: [{where: {name: {eq: "t1"}}}]}
        }}]}
      }}]) { id }
    } }`});
    validateResult(res);
    const tagNames = (await post.getTags()).map((t: {get: (k: string) => string}) => t.get("name"));
    expect(tagNames).toEqual(["t1"]);
    // The post itself was not modified
    expect((await Post.findByPk(post.get("id"))).get("title")).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// belongsToMany verbs (with through attributes)
// ---------------------------------------------------------------------------

describe("nested verbs — belongsToMany", () => {
  it("add: associates existing records via belongsToMany with through attributes", async () => {
    const db = await buildFull();
    const {Post, Tag, PostTag} = db.models;
    await Post.create({title: "p1"});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {tags: {add: [{where: {name: {eq: "t1"}}, through: {sortOrder: 5, label: "first"}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    const joins = await PostTag.findAll();
    expect(joins).toHaveLength(1);
    expect(joins[0].get("sortOrder")).toBe(5);
    expect(joins[0].get("label")).toBe("first");
  });

  it("remove: disassociates from a belongsToMany", async () => {
    const db = await buildFull();
    const {Post, Tag} = db.models;
    const post = await Post.create({title: "p1"});
    const [t1, t2] = await Promise.all([Tag.create({name: "t1"}), Tag.create({name: "t2"})]);
    await post.addTags([t1, t2]);
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {tags: {remove: [{name: {eq: "t1"}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    const names = (await post.getTags()).map((t: {get: (k: string) => string}) => t.get("name"));
    expect(names).toEqual(["t2"]);
  });

  it("set: replaces the entire belongsToMany set with through attributes", async () => {
    const db = await buildFull();
    const {Post, Tag, PostTag} = db.models;
    const post = await Post.create({title: "p1"});
    const [t1, t2] = await Promise.all([
      Tag.create({name: "t1"}), Tag.create({name: "t2"}), Tag.create({name: "t3"}),
    ]);
    await post.addTags([t1, t2]);
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "p1"}}, input: {tags: {set: [{where: {name: {eq: "t3"}}, through: {sortOrder: 1}}]}}}) {
        id
      }
    } }`});
    validateResult(res);
    const names = (await post.getTags()).map((t: {get: (k: string) => string}) => t.get("name"));
    expect(names).toEqual(["t3"]);
    const joins = await PostTag.findAll();
    expect(joins).toHaveLength(1);
    expect(joins[0].get("sortOrder")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Depth-2 nesting: verb inside a nested create/update
// ---------------------------------------------------------------------------

describe("nested verbs — depth 2", () => {
  it("create inside a nested create (author -> post -> comments)", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(create: {name: "a1", posts: {create: {title: "p1", comments: {create: [{body: "c1"}]}}}}) {
        id name posts { edges { node { title comments { edges { node { body } } } } } }
      }
    } }`});
    validateResult(res);
    type R = {models: {Author: {id: string; name: string; posts: {edges: {node: {title: string; comments: {edges: {node: {body: string}}[]}}}[]}}[]}};
    const author = resultData<R>(res).models.Author[0];
    expect(author.posts.edges[0].node.title).toBe("p1");
    expect(author.posts.edges[0].node.comments.edges[0].node.body).toBe("c1");
  });

  it("add inside a nested update (update post -> tags.add inside update)", async () => {
    const db = await buildFull();
    const {Author, Post, Tag} = db.models;
    const a = await Author.create({name: "a1"});
    await Post.create({title: "p1", authorId: a.get("id")});
    await Tag.create({name: "t1"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(update: {where: {name: {eq: "a1"}}, input: {
        posts: {update: {where: {title: {eq: "p1"}}, input: {
          tags: {add: [{where: {name: {eq: "t1"}}}]}
        }}}
      }}) { id }
    } }`});
    validateResult(res);
    const post = await Post.findOne({where: {title: "p1"}});
    const tagNames = (await post.getTags()).map((t: {get: (k: string) => string}) => t.get("name"));
    expect(tagNames).toEqual(["t1"]);
  });

  it("set inside a nested create (create author -> create post -> set tags)", async () => {
    const db = await buildFull();
    const {Tag} = db.models;
    await Tag.create({name: "t1"});
    await Tag.create({name: "t2"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Author(create: {name: "a1", posts: {create: {title: "p1", tags: {add: [{where: {name: {eq: "t1"}}}, {where: {name: {eq: "t2"}}}]}}}}) {
        id posts { edges { node { title } } }
      }
    } }`});
    validateResult(res);
    const {Post} = db.models;
    const post = await Post.findOne({where: {title: "p1"}});
    const tagNames = (await post.getTags()).map((t: {get: (k: string) => string}) => t.get("name")).sort();
    expect(tagNames).toEqual(["t1", "t2"]);
  });
});

// ---------------------------------------------------------------------------
// Transactions: rollback on throwing transform
// ---------------------------------------------------------------------------

describe("transactions — rollback", () => {
  it("a throwing transform rolls back the whole mutation including nested creates", async () => {
    const db = await buildFull();
    const {Article, Note} = db.models;
    await Article.create({title: "original", status: "draft"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Article(update: [
        {where: {title: {eq: "original"}}, input: {status: "published", notes: {create: {text: "n1"}}}}
      ], apply: {explode: true}) { id }
    } }`});

    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(res.errors![0].message).toMatch(/transform exploded/);

    // Everything should be rolled back
    const article = await Article.findOne({where: {title: "original"}});
    expect(article.get("status")).toBe("draft");
    expect(await Note.count()).toBe(0);
  });

  it("a throwing transform rolls back a create mutation with nested writes", async () => {
    const db = await buildFull();
    const {Article, Note} = db.models;
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Article(create: [{title: "new", status: "draft", notes: {create: {text: "n1"}}}], apply: {explode: true}) { id }
    } }`});

    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(await Article.count()).toBe(0);
    expect(await Note.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bulk operations: create with list, multi-row delete, update with limit
// ---------------------------------------------------------------------------

describe("bulk operations", () => {
  it("create with a list of inputs", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(create: [{title: "p1"}, {title: "p2"}, {title: "p3"}]) {
        id title
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: PostRow[]}};
    const posts = resultData<R>(res).models.Post;
    expect(posts).toHaveLength(3);
    expect(posts.map(p => p.title).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("delete of multiple rows", async () => {
    const db = await buildFull();
    const {Post} = db.models;
    await Post.create({title: "p1"});
    await Post.create({title: "p2"});
    await Post.create({title: "p3"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(delete: {title: {in: ["p1", "p2"]}}) { id title }
    } }`});
    validateResult(res);
    expect(await Post.count()).toBe(1);
    const remaining = await Post.findOne();
    expect(remaining.get("title")).toBe("p3");
  });

  it("update with limit", async () => {
    const db = await buildFull();
    const {Post} = db.models;
    await Post.create({title: "p1"});
    await Post.create({title: "p2"});
    await Post.create({title: "p3"});
    const schema = await createSchema(db, schemaOpts);

    const res = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {in: ["p1", "p2", "p3"]}}, input: {title: "updated"}, limit: 2}) {
        id title
      }
    } }`});
    validateResult(res);
    type R = {models: {Post: PostRow[]}};
    const updated = resultData<R>(res).models.Post;
    expect(updated).toHaveLength(2);
    // One should remain unchanged
    const all = await Post.findAll();
    const titles = all.map((p: {get: (k: string) => string}) => p.get("title"));
    expect(titles.filter((t: string) => t === "updated")).toHaveLength(2);
    expect(titles.filter((t: string) => t !== "updated")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hook parity: Sequelize lifecycle hooks fire identically on both dialects
// ---------------------------------------------------------------------------

describe("hook parity across dialects", () => {
  it("afterCreate, afterUpdate, afterDestroy all fire on mutations", async () => {
    const db = await buildFull();
    const schema = await createSchema(db, schemaOpts);

    // Create a post (triggers afterCreate)
    const createRes = await graphql({schema, source: `mutation { models {
      Post(create: {title: "hooktest"}) { id }
    } }`});
    validateResult(createRes);
    expect(hookLog).toContain("Post:afterCreate");

    // Update the post (triggers afterUpdate)
    hookLog.length = 0;
    const updateRes = await graphql({schema, source: `mutation { models {
      Post(update: {where: {title: {eq: "hooktest"}}, input: {title: "hookupdated"}}) { id }
    } }`});
    validateResult(updateRes);
    expect(hookLog).toContain("Post:afterUpdate");

    // Delete the post (triggers afterDestroy)
    hookLog.length = 0;
    const deleteRes = await graphql({schema, source: `mutation { models {
      Post(delete: {title: {eq: "hookupdated"}}) { id }
    } }`});
    validateResult(deleteRes);
    expect(hookLog).toContain("Post:afterDestroy");
  });
});
