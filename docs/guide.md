# gqlize — Usage Guide

A practical, example-driven guide to building and querying a gqlize GraphQL schema. For the
architecture/contract reference, see [**specifications.md**](specifications.md).

Every example below is drawn from the behaviour exercised in the test suite
(`packages/gqlize/__tests__`).

## Contents

1. [Installation](#1-installation)
2. [Quick start](#2-quick-start)
3. [Defining models](#3-defining-models)
4. [Serving the schema](#4-serving-the-schema)
5. [Querying](#5-querying)
   - [Lists & Relay connections](#lists--relay-connections)
   - [Filtering (`where`)](#filtering-where)
   - [Ordering (`orderBy`)](#ordering-orderby)
   - [Pagination (cursors)](#pagination-cursors)
   - [Relationships & eager loading](#relationships--eager-loading)
   - [Count-only (`total`)](#count-only-total)
   - [Global IDs & `node`](#global-ids--node)
   - [Class & instance methods](#class--instance-methods)
6. [Mutations](#6-mutations)
   - [Create / update / delete](#create--update--delete)
   - [Nested relationship writes](#nested-relationship-writes)
   - [Class-method mutations](#class-method-mutations)
7. [Permissions](#7-permissions)
8. [Hooks](#8-hooks)
9. [Custom scalars & JSON columns](#9-custom-scalars--json-columns)
10. [Multiple data sources](#10-multiple-data-sources)

---

## 1. Installation

```sh
pnpm add @azerothian/ormize @azerothian/gqlize @azerothian/ormize-adapter-sequelize
# peer dependencies
pnpm add graphql@^17.0.0 graphql-relay@^0.10 sequelize@^6
# plus a Sequelize driver, e.g. sqlite3 / pg
```

> **Required graphql patch.** gqlize needs a mutation's *nested* sub-fields to execute serially
> (stock graphql only serializes top-level mutation fields). Apply the committed pnpm patch as
> the packages do — see [specifications.md §12](specifications.md#12-the-graphql-patch). Without
> it, deep nested mutations are not guaranteed to run in order.

---

## 2. Quick start

```ts
import { Ormize } from "@azerothian/ormize";
import { createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import { graphql } from "graphql";

const db = new Ormize();

// 1. Register a data-source adapter (the first becomes the default).
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");

// 2. Register model definitions.
db.addDefinition({
  name: "Author",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
});

// 3. Wire relationships across adapters, then bring the adapters online.
await db.initialise();
await db.sync();               // create tables (Sequelize sync)

// 4. Build a standard graphql schema.
const schema = await createSchema(db);

// 5. Run it.
const { Author } = db.models;  // the underlying Sequelize models
await Author.create({ name: "Ada" });

const result = await graphql({
  schema,
  source: `query { models { Author { edges { node { id name } } } } }`,
});
console.log(result.data.models.Author.edges); // [{ node: { id, name: "Ada" } }]
```

The lifecycle is always: **`new Ormize()` → `registerAdapter` → `addDefinition` (×N) →
`initialise()` → `sync()` → `createSchema(orm)`**.

---

## 3. Defining models

A *definition* is a plain object passed to `db.addDefinition`. The example schema used
throughout this guide:

```ts
db.addDefinition({
  name: "Author",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  relationships: [
    { type: "hasMany", model: "Post", name: "posts", options: { foreignKey: "authorId" } },
  ],
});

db.addDefinition({
  name: "Tag",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  relationships: [
    { type: "belongsToMany", model: "Post", name: "posts",
      options: { through: { model: "PostTag" }, foreignKey: "tagId", otherKey: "postId" } },
  ],
});

// Join table with an extra column (used for belongsToMany `through` writes).
db.addDefinition({
  name: "PostTag",
  define: { sortOrder: { type: Sequelize.INTEGER, allowNull: true } },
});

// A paranoid (soft-delete) model — enables `restore`.
db.addDefinition({
  name: "Comment",
  define: { body: { type: Sequelize.STRING, allowNull: false } },
  relationships: [
    { type: "belongsTo", model: "Post", name: "post", options: { foreignKey: "postId" } },
  ],
  options: { paranoid: true },
});

db.addDefinition({
  name: "Post",
  define: {
    title: { type: Sequelize.STRING, allowNull: false },
    body:  { type: Sequelize.STRING, allowNull: true },
  },
  relationships: [
    { type: "belongsTo",      model: "Author",  name: "author",   options: { foreignKey: "authorId" } },
    { type: "hasMany",        model: "Comment", name: "comments", options: { foreignKey: "postId" } },
    { type: "belongsToMany",  model: "Tag",     name: "tags",
      options: { through: { model: "PostTag" }, foreignKey: "postId", otherKey: "tagId" } },
  ],
});
```

Definition keys you'll commonly use:

- **`define`** — a Sequelize attribute map; supports `validate`, `defaultValue`, `values` (enum),
  `allowNull`, `primaryKey`, etc. Primary and foreign keys are exposed as Relay **global IDs**.
- **`relationships`** — `{ type, model, name, options }`, `type` ∈ `belongsTo | hasOne | hasMany
  | belongsToMany`. `options` carries `foreignKey`/`otherKey`/`as`/`through`.
- **`override`** — expose a column as a different GraphQL type with `input`/`output` transforms
  (see [§9](#9-custom-scalars--json-columns)).
- **`whereOperators` / `whereOperatorTypes`** — custom filter operators usable in `where`
  (see [Filtering](#filtering-where)).
- **`expose.classMethods` / `expose.instanceMethods`** — surface methods to GraphQL under
  `query` and `mutations` (see [Class & instance methods](#class--instance-methods)).
- **`options`** — passed to Sequelize: `tableName`, `paranoid`, `indexes`, `hooks`, and the
  `classMethods`/`instanceMethods` implementations.

> **Junction models.** A `through` model that only carries FK columns (+ your extra columns) has
> no relationships of its own; exclude it from the schema with a permission gate so it isn't
> exposed: `createSchema(db, { permission: { model: (n) => n !== "PostTag" } })`.

### Typed models (TypeScript, opt-in)

`db.models.<Name>` is `any` by default. To get strongly-typed models, declare the instance
interface the standard [Sequelize v6 way](https://sequelize.org/docs/v6/other-topics/typescript/),
wrap the definition with the adapter's `defineModel`, and register with the fluent `db.define(...)`:

```ts
import Sequelize, {
  Model, InferAttributes, InferCreationAttributes, CreationOptional,
} from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter, { defineModel } from "@azerothian/ormize-adapter-sequelize";

interface TaskInstance
  extends Model<InferAttributes<TaskInstance>, InferCreationAttributes<TaskInstance>> {
  id: CreationOptional<number>;
  name: string;
}
const TaskDef = defineModel<TaskInstance, { countAll(a: any, c: any): Promise<number> }>({
  name: "Task",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  classMethods: { async countAll(this: any) { return this.count(); } },
});

const db = new Ormize()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef);
await db.initialise();
await db.sync();

await db.models.Task.create({ name: "alpha" });  // typed; create({}) is a compile error
await db.models.Task.countAll(undefined, {});    // Promise<number>
```

Compose a model from several fragments with `SequelizeModel<Required, Optional>` — required
fragments contribute required members, optional fragments contribute optional (`?`) members.
See the [adapter README → Typed models](../packages/ormize-adapter-sequelize/README.md#typed-models)
for the full reference. The untyped `db.addDefinition(def)` remains available.

---

## 4. Serving the schema

`createSchema` returns a standard `graphql` `GraphQLSchema`; serve it with any GraphQL server.
graphql-yoga (on Node's built-in http server):

```ts
import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";

const schema = await createSchema(db);
const yoga = createYoga({
  schema,
  context: () => ({ instance: db }),   // available to resolvers/hooks
});
createServer(yoga).listen(3005);
```

Dump the generated SDL to inspect the type/argument names:

```ts
import { printSchema } from "graphql";
console.log(printSchema(await createSchema(db)));
```

---

## 5. Querying

All model queries live under the root `models` field. A model's list field is a
**Relay-style connection**.

### Lists & Relay connections

```graphql
query {
  models {
    Post {
      edges {
        node { id title body }
        cursor
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      total          # Int — total records available (backed by an inline COUNT on supported dialects)
    }
  }
}
```

### Filtering (`where`)

Every list/relationship field takes a `where` argument. Per field you supply operators:

```graphql
query {
  models {
    Post(where: { title: { eq: "Hello" } }) { edges { node { id } } }
  }
}
```

Available operators (from the generated filter type):

- **value:** `eq`, `ne`, `gte`, `lte`, `lt`, `not`, `is`, `like`, `notLike`, `iLike`, `notILike`,
  `startsWith`, `endsWith`, `substring`, `regexp`, `notRegexp`, `iRegexp`, `notIRegexp`
- **list:** `in`, `notIn`, `between`, `notBetween`, `contains`, `contained`, `overlap`, … (array-valued)
- **combinators:** `and`, `or`, `any`, `all` (each takes a list of whole `where` objects)

```graphql
# combine conditions
Post(where: { and: [ { title: { like: "Intro%" } }, { body: { ne: null } } ] }) { edges { node { id } } }

# list membership
Post(where: { title: { in: ["a", "b", "c"] } }) { edges { node { id } } }
```

**Custom operators.** Declare them on the model with `whereOperators`/`whereOperatorTypes`:

```ts
whereOperators: {
  async hasNoComments(newWhere, findOptions) {
    return { id: { [Sequelize.Op.notIn]: Sequelize.literal(`(SELECT DISTINCT("postId") FROM "Comments")`) } };
  },
},
whereOperatorTypes: { hasNoComments: GraphQLBoolean },
```
```graphql
Post(where: { hasNoComments: true }) { edges { node { id title } } }
```

### Ordering (`orderBy`)

`orderBy` is an enum named `{Model}OrderBy` with `{field}ASC` / `{field}DESC` values:

```graphql
Post(orderBy: titleASC)  { edges { node { title } } }
Post(orderBy: createdAtDESC) { edges { node { title } } }
```

### Pagination (cursors)

Cursor arguments: `first`, `after`, `last`, `before`. Cursors are opaque base64 strings you copy
from `edges[].cursor` (or `pageInfo.startCursor`/`endCursor`):

```graphql
# page 1
query { models { Post(first: 10) { edges { cursor node { id } } pageInfo { endCursor hasNextPage } } } }

# page 2 — pass the previous page's cursor
query { models { Post(first: 10, after: "eyJpZCI6..." ) { edges { cursor node { id } } } } }
```

### Relationships & eager loading

Selecting a relationship eager-loads it — you don't write joins. gqlize builds the query from
your selection set:

```graphql
query {
  models {
    Post {
      edges {
        node {
          title
          author { name }                              # belongsTo (single object)
          comments { edges { node { body } } }         # hasMany (connection)
          tags { edges { node { name } } }             # belongsToMany (connection)
        }
      }
    }
  }
}
```

Nested relationship fields accept their own `where`, `orderBy`, and pagination:

```graphql
comments(where: { body: { like: "%thanks%" } }, orderBy: createdAtDESC, first: 5) {
  edges { node { body } }
}
```

By default a nested `where` is a **LEFT JOIN** (parents are still returned, children filtered).
Add **`required: true`** for an INNER JOIN that also filters the parents:

```graphql
# only Posts that have a matching comment
Post { edges { node { title comments(required: true, where: { body: { eq: "first!" } }) { edges { node { body } } } } } }

# single-valued too — only Posts that have an author
Post { edges { node { title author(required: true) { name } } } }
```

You can also drive eager loading explicitly with the `include` argument (fields: `required`,
`separate`, `where`, `orderBy`, and nested `include`). It merges with the selection:

```graphql
Post(include: { comments: { required: true, where: { body: { eq: "hi" } } } }) {
  edges { node { title comments { edges { node { body } } } } }
}
```

Non-paginated relations fold into a single JOINed query; a nested `hasMany` with pagination
(`first`/`last`) is loaded via a batched `separate:true` query so per-parent limits are correct.

### Count-only (`total`)

Select only `total` (no `edges`) to run a **count** instead of fetching rows:

```graphql
query { models { Post { edges { node { title comments { total } } } } } }   # per-post comment counts
query { models { Comment { total } } }                                       # top-level count
```

### Global IDs & `node`

Primary/foreign keys are Relay global IDs. Fetch any object by its global ID via `node`:

```graphql
query ($id: ID!) {
  node(id: $id) {
    id
    __typename
    ... on Post { title }
  }
}
```

### Class & instance methods

Expose model methods to GraphQL. Declare the surface with `expose` and implement under `options`:

```ts
db.addDefinition({
  name: "Post",
  define: { title: { type: Sequelize.STRING } },
  expose: {
    classMethods: {
      query:     { latest: { type: "Post[]", args: {} } },
      mutations: { publish: { type: "Post", args: { input: { type: /* GraphQLInputObjectType */ } } } },
    },
    instanceMethods: {
      query: { wordCount: { type: /* GraphQLInt */, args: {} } },
    },
  },
  options: {
    classMethods: {
      async latest(args, req) { return this.findAll({ order: [["createdAt", "DESC"]], limit: 5 }); },
    },
    instanceMethods: {
      wordCount(args, req) { return (this.title || "").split(" ").length; },
    },
  },
});
```

Query class/instance methods:

```graphql
query { classMethods { Post { latest { id title } } } }        # class method (list)
query { models { Post { edges { node { wordCount } } } } }     # instance method on each node
```

Method `type` may be a string reference (`"Post"`, `"Post[]"`) or a concrete GraphQL type.

---

## 6. Mutations

Top-level mutations live under `mutation { models { {Model}(...) { …selection } } }`. Create /
update / delete **return arrays** (`data.models.Post[0]`), not connections.

### Create / update / delete

```graphql
# create (single or array)
mutation { models { Post(create: { title: "Hello", body: "world" }) { id title } } }
mutation { models { Tag(create: [ { name: "a" }, { name: "b" } ]) { id name } } }

# update — { where, input } (optional `limit`)
mutation { models { Post(update: { where: { title: { eq: "Hello" } }, input: { title: "Updated" } }) { id title } } }

# delete — a filter (or a list of filters)
mutation { models { Post(delete: { title: { in: ["a", "b"] } }) { id } } }
```

Delete with a variable (the delete arg type is `[GQLTQuery{Model}Where]`):

```graphql
mutation ($where: [GQLTQueryPostWhere]) { models { Post(delete: $where) { id } } }
```

### Nested relationship writes

A relationship field inside a create/update `input` accepts operations that vary by association
type. Available operations:

| Operation | belongsTo / hasOne | hasMany / belongsToMany | What it does |
| --- | :---: | :---: | --- |
| `create` | ✅ | ✅ | create new related record(s) and associate |
| `update` | ✅ | ✅ | `{ where, input }` — update matching related |
| `delete` | ✅ | ✅ | delete matching related |
| `add` | — | ✅ | associate existing matching records (by `where`) |
| `remove` | ✅ (`Boolean`) | ✅ (filter) | disassociate (belongsTo: `true` → null the FK) |
| `set` | ✅ (filter → one) | ✅ (filter → replace all) | associate an existing record / replace the whole set |
| `restore` | ✅ | ✅ | undelete soft-deleted (paranoid) related records |

**Create nested** (deeply, at any depth):

```graphql
mutation {
  models {
    Post(create: {
      title: "New",
      comments: { create: [ { body: "first" }, { body: "second" } ] }
    }) { id comments { edges { node { body } } } }
  }
}
```

**Add / remove existing** (hasMany / belongsToMany):

```graphql
# associate existing tags found by filter
mutation {
  models {
    Post(update: {
      where: { title: { eq: "New" } },
      input: { tags: { add: [ { where: { name: { eq: "a" } } }, { where: { name: { eq: "b" } } } ] } }
    }) { id }
  }
}

# disassociate matching tags (row survives; join removed)
Post(update: { where: { title: { eq: "New" } }, input: { tags: { remove: [ { name: { eq: "a" } } ] } } }) { id }
```

**Set** — associate an existing single relation, or replace an entire collection:

```graphql
# belongsTo: point author at the existing "Ada" (found by filter)
Post(update: { where: { title: { eq: "New" } }, input: { author: { set: { name: { eq: "Ada" } } } } }) { id author { name } }

# belongsTo: disassociate
Post(update: { where: { title: { eq: "New" } }, input: { author: { remove: true } } }) { id author { name } }

# hasMany / belongsToMany: replace the whole set with the matching records
Post(update: { where: { title: { eq: "New" } }, input: { tags: { set: [ { where: { name: { eq: "c" } } } ] } } }) { id }
```

**belongsToMany `through` attributes** — write join-table columns when associating:

```graphql
Post(update: {
  where: { title: { eq: "New" } },
  input: { tags: { add: [ { where: { name: { eq: "a" } }, through: { sortOrder: 7 } } ] } }
}) { id }
```

**Restore** — undelete soft-deleted related records (paranoid models):

```graphql
Post(update: { where: { title: { eq: "New" } }, input: { comments: { restore: [ { body: { eq: "first" } } ] } } }) { id }
```

**Select** — find existing records by filter and run **further relationship mutations on them**
without modifying the found records themselves (no field write, no create/update/delete). Available
both **top-level** (a sibling of `create` / `update` / `delete`) and **nested** on any relationship
(a sibling of `update` / `set` / `add`). Nested `select` is **relationship-scoped** — it only sees
records already related to the parent. Scalar fields inside `input` are ignored — only the
relationship sub-mutations run.

```graphql
# top-level: find each Author, then (relationship-scoped) find their "draft" posts and tag them.
# The authors and posts themselves are NOT modified.
mutation {
  models {
    Author(select: [{
      where: { name: { eq: "Ada" } },
      input: {
        posts: { select: [{
          where: { status: { eq: "draft" } },
          input: { tags: { add: [ { where: { name: { eq: "featured" } } } ] } }
        }] }
      }
    }]) { id name }        # returns the found authors (unchanged)
  }
}

# nested inside another mutation, and on a singular relationship:
Post(update: {
  where: { title: { eq: "New" } },
  input: { author: { select: { where: { name: { eq: "Ada" } }, input: { posts: { create: [ { title: "Another" } ] } } } } }
}) { id }
```

### Class-method mutations

```graphql
mutation { classMethods { Post { publish(input: { amount: 2 }) { id title } } } }
```

---

## 7. Permissions

Pass a `permission` object as the second argument to `createSchema`. Each key is a predicate
returning a boolean; returning falsy removes the corresponding element from the schema.

```ts
const schema = await createSchema(db, {
  permission: {
    model:        (modelName) => modelName !== "PostTag",       // hide a model
    field:        (modelName, fieldName) => true,               // hide a field on the node type
    query:        (modelName) => true,                          // hide a model's list query
    mutation:     (modelName) => true,
    mutationCreate: (modelName) => true,
    mutationUpdate: (modelName) => true,
    mutationDelete: (modelName) => true,
    mutationCreateInput: (modelName, fieldName) => true,        // hide a create-input field
    mutationUpdateInput: (modelName, fieldName) => true,
    relationship: (modelName, relName, targetName) => true,
    queryClassMethods:    (modelName, methodName) => true,
    mutationClassMethods: (modelName, methodName) => true,
    queryInstanceMethods: (modelName, methodName) => true,
    options: { /* shared value passed to every predicate */ },
  },
});
```

**Role-based helper.** `createRoleBasedPermissions(role, rules, options?)` compiles an
allow/deny rules tree into the `permission` object above (defaults to deny):

```ts
import createRoleBasedPermissions from "@azerothian/gqlize/permission-helper"; // default export

const permission = createRoleBasedPermissions("anyone", {
  someone: "deny",
  anyone: {
    query: "allow",
    model: { Post: "allow", Author: "allow" },
    field: { Post: { title: "allow", body: "allow" } },
  },
});
const schema = await createSchema(db, { permission });
```

---

## 8. Hooks

Two hook systems.

**Definition-level `before` / `after`** — transform query options / mutation inputs / results,
discriminated by the `Events` enum (`QUERY`, `MUTATION_CREATE`, `MUTATION_UPDATE`,
`MUTATION_DELETE`, `OUTPUT`):

```ts
import events from "@azerothian/ormize/events";

db.addDefinition({
  name: "Post",
  define: { title: { type: Sequelize.STRING } },
  before(req) {
    if (req.type === events.MUTATION_CREATE) {
      return Object.assign({}, req.params, { title: req.params.title.trim() });
    }
    return req.params;
  },
  after(req) { return req.result; },
});
```

**Sequelize lifecycle hooks** (`options.hooks`) — `beforeFind`, `beforeCreate`, `afterFind`,
`beforeCount`, etc. A `beforeFind` can read the originating GraphQL args via
`options.getGraphQLArgs()` (fed by the query's `rootValue`):

```ts
options: {
  hooks: {
    beforeFind(options) {
      if (options.getGraphQLArgs) {
        const { info } = options.getGraphQLArgs();
        const filter = info.rootValue && info.rootValue.filterName;
        if (filter) { options.where = { name: { [Sequelize.Op.ne]: filter } }; }
      }
      return options;
    },
  },
}
```

Global hooks (all models) can be supplied via `new Ormize({ globalHooks: { … } })` or
`db.addHook(name, fn)`. The count-only query path additionally fires `beforeCount` and a
gqlize-level `afterCount(total)` (which may transform the returned count).

---

## 9. Custom scalars & JSON columns

`@azerothian/graphql-types` provides ready-made scalars:

```ts
import DateType from "@azerothian/graphql-types/date";     // ISO string <-> Date  (GQLTDate)
import JSONType from "@azerothian/graphql-types/json";     // arbitrary JSON        (GQLTJson)
import BigIntType from "@azerothian/graphql-types/bigint";
import IPType from "@azerothian/graphql-types/ip";
import UploadType from "@azerothian/graphql-types/upload"; // multipart uploads     (GQLTUpload)
```

**JSON stored in a string column** — expose a text column as a structured GraphQL object with
`override` (`input` serializes on write, `output` deserializes on read):

```ts
db.addDefinition({
  name: "Post",
  define: {
    title:    { type: Sequelize.STRING },
    metadata: { type: Sequelize.STRING },   // stored as JSON text
  },
  override: {
    metadata: {
      type: { name: "PostMetadata", fields: { slug: { type: GraphQLString } } },
      output(result) { return JSON.parse(result.get("metadata") || "{}"); },
      input(field, args, context, info, model) {
        const current = model && model.get("metadata");
        const merged = Object.assign({}, current ? JSON.parse(current) : {}, field);
        return JSON.stringify(merged);       // merge on update
      },
    },
  },
});
```
```graphql
mutation { models { Post(create: { title: "x", metadata: { slug: "hello" } }) { id metadata { slug } } } }
```

---

## 10. Multiple data sources

Register more than one adapter and route models to them. Relationships whose target lives on a
**different** adapter are resolved as their own root queries (they can't be JOINed across
databases):

```ts
db.registerAdapter(new SequelizeAdapter({}, { dialect: "postgres", /* … */ }), "pg");
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");

db.addDefinition({ name: "Post", datasource: "pg",     define: { /* … */ } });
db.addDefinition({ name: "Audit", datasource: "sqlite", define: { /* … */ } });
```

A definition's `datasource` (or the second arg to `addDefinition`) selects its adapter; the
first registered adapter is the default.

---

*See [specifications.md](specifications.md) for the architecture, the adapter contract, and the
full generated-schema reference.*
