# gqlize — Usage Guide

A practical, example-driven guide to building and querying a gqlize GraphQL schema. For the
architecture/contract reference, see [**specifications.md**](specifications.md).

Every example below is drawn from the behaviour exercised in the test suite
(`packages/gqlize/__tests__`).

## Contents

1. [Installation](#1-installation)
2. [Quick start](#2-quick-start)
3. [Defining models](#3-defining-models)
   - [Field arguments & field resolvers](#field-arguments--field-resolvers)
   - [Soft delete (`paranoid`)](#soft-delete-paranoid)
   - [Typed models (TypeScript, opt-in)](#typed-models-typescript-opt-in)
4. [Serving the schema](#4-serving-the-schema)
5. [Pre-generated schema artifacts](#5-pre-generated-schema-artifacts)
6. [Querying](#6-querying)
   - [Lists & Relay connections](#lists--relay-connections)
   - [Filtering (`where`)](#filtering-where)
   - [Ordering (`orderBy`)](#ordering-orderby)
   - [Pagination (cursors)](#pagination-cursors)
   - [Relationships & eager loading](#relationships--eager-loading)
   - [Count-only (`total`)](#count-only-total)
   - [Soft-deleted rows (`deleted`)](#soft-deleted-rows-deleted)
   - [Global IDs & `node`](#global-ids--node)
   - [Custom ID & cursor formats](#custom-id--cursor-formats)
   - [Class & instance methods](#class--instance-methods)
     - [The declarative keys](#the-declarative-keys)
7. [Mutations](#7-mutations)
   - [Create / update / delete](#create--update--delete)
   - [Restoring soft-deleted rows](#restoring-soft-deleted-rows)
   - [Nested relationship writes](#nested-relationship-writes)
   - [Class-method mutations](#class-method-mutations)
   - [Instance-method transforms (`apply`)](#instance-method-transforms-apply)
8. [Permissions](#8-permissions)
9. [Hooks](#9-hooks)
10. [Custom scalars & JSON columns](#10-custom-scalars--json-columns)
11. [Multiple data sources](#11-multiple-data-sources)
12. [Transactions & async context](#12-transactions--async-context)
13. [The Valkey / Redis adapter](#13-the-valkey--redis-adapter)

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
  A field may also carry `description`, `args` and `resolve`
  (see [below](#field-arguments--field-resolvers)).
- **`relationships`** — `{ type, model, name, options }`, `type` ∈ `belongsTo | hasOne | hasMany
  | belongsToMany`. `options` carries `foreignKey`/`otherKey`/`as`/`through`.
- **`override`** — expose a column as a different GraphQL type with `input`/`output` transforms
  (see [§10](#10-custom-scalars--json-columns)).
- **`whereOperators` / `whereOperatorTypes`** — custom filter operators usable in `where`
  (see [Filtering](#filtering-where)).
- **`expose.classMethods` / `expose.instanceMethods`** — surface methods to GraphQL under
  `query` and `mutations` (see [Class & instance methods](#class--instance-methods)).
- **`options`** — passed to Sequelize: `tableName`, `paranoid`, `indexes`, `hooks`, and the
  `classMethods`/`instanceMethods` implementations.

> **Junction models.** A `through` model that only carries FK columns (+ your extra columns) has
> no relationships of its own; exclude it from the schema with a permission gate so it isn't
> exposed: `createSchema(db, { permission: { model: (n) => n !== "PostTag" } })`.

### Field arguments & field resolvers

A field in `define` can take GraphQL arguments and compute its own value. Both keys are optional
and independent — `args` alone gives the field arguments its default property resolver ignores;
`resolve` alone replaces how the field is read:

```ts
const Casing = new GraphQLEnumType({
  name: "Casing",
  values: { UPPER: { value: "UPPER" }, LOWER: { value: "LOWER" } },
});

db.addDefinition({
  name: "Post",
  define: {
    title: { type: Sequelize.STRING, allowNull: false },
    body: {
      type: Sequelize.STRING,
      allowNull: true,
      description: "The post body, optionally re-cased.",
      // Passed to GraphQL verbatim — the value is a standard field-args map.
      args: { casing: { type: Casing } },
      // Standard GraphQL signature: (source, args, context, info)
      resolve: (source, args) =>
        args.casing === "UPPER" ? source.body.toUpperCase() : source.body.toLowerCase(),
    },
  },
});
```

…which prints as `body(casing: Casing): String`, and is queried like any other field:

```graphql
query { models { Post { edges { node { title body(casing: UPPER) } } } } }
```

Notes:

- `type` still declares the **column**; `resolve` only changes how it is read. To expose a column
  as a *different* GraphQL type, use `override`
  ([§10](#10-custom-scalars--json-columns)) instead.
- `description` sets the field's GraphQL description; on the Sequelize adapter the native `comment`
  spelling (which also reaches the database) works too, and `description` wins if both are given.
  The definition-level `comments.fields` map wins over either.
- Argument types are user-authored, so they cannot be serialized into a
  [pre-generated artifact](#5-pre-generated-schema-artifacts) — they are re-derived from the live
  definition at load, exactly like `whereOperatorTypes`. Keep the definition module importable at
  runtime and the artifact round-trips, custom enum internal values included.
- Adding or removing either key changes the artifact's `models` fingerprint, so `gqlize check`
  will report the artifact stale and it needs a rebuild.

### Deprecating fields

Renaming or retiring a column is otherwise a hard breaking change with no warning path.
`@deprecated` is that path: clients keep working, their tooling flags the field, and you get to
remove it later.

Write the reason on the declaration itself:

```ts
{
  name: "Post",
  define: {
    title:    { type: Sequelize.STRING },
    subtitle: { type: Sequelize.STRING, deprecated: "use `title`" },
  },
  expose: {
    classMethods: { query: { legacySearch: { type: "Post[]", deprecated: "use `Post(where:)`" } } },
  },
}
```

…or in a central `deprecations` map, which mirrors `comments` and **wins** over the declaration:

```ts
{
  name: "Post",
  relationships: [{ type: "hasMany", model: "Comment", name: "comments", options: {...} }],
  deprecations: {
    fields: {
      subtitle: "use `title`",
      comments: "use `Comment(where: { postId: ... })`",   // a relationship has no `deprecated` slot
    },
    classMethods:    { legacySearch: "use `Post(where:)`" },   // class-method query fields
    instanceMethods: { trimTitle:    "the server trims on write now" },  // `apply` transforms
  },
}
```

The map is the only way to deprecate a declaration you did not author — a relationship, an
inherited column — which is why it takes precedence.

The three groups mirror `comments` exactly, and land where `comments` lands:

| Group | Marks |
| --- | --- |
| `fields` | columns, relationships, and instance-method **query** fields |
| `classMethods` | class-method query fields (`QueryClassMethods.Post.<name>`) |
| `instanceMethods` | the `apply` input field for each instance-method **transform** |

Note the asymmetry in the first two rows: an instance-method *query* field deprecates through
`fields`, because that is where its description comes from too. `instanceMethods` is reserved for
the pre-commit transforms surfaced on the model's `apply` input.

Deprecate a whole model with a top-level `deprecated`. GraphQL cannot deprecate an object type, so
the mark lands on the two fields that lead to it, `QueryModels.Post` and `MutationModels.Post`:

```ts
{ name: "Post", deprecated: "merged into Article", define: {...} }
```

What gets marked:

```graphql
type Post {
  subtitle: String @deprecated(reason: "use `title`")
  comments(...): CommentHasManyCommentsList @deprecated(reason: "use `Comment(where: { postId: ... })`")
}

enum PostOrderBy {
  subtitleASC  @deprecated(reason: "use `title`")   # both halves of the pair —
  subtitleDESC @deprecated(reason: "use `title`")   # a deprecated column should not stay sortable
}

input PostOptionalInput {
  subtitle: String @deprecated(reason: "use `title`")
}
```

**One asymmetry to expect.** GraphQL rejects `@deprecated` on a *required* input field — a client
cannot stop sending a value it is obliged to send — so a deprecated `NOT NULL` column shows the
reason on `PostOptionalInput` (update) but not on `PostRequiredInput` (create). That is the spec's
rule, not gqlize's.

An empty string is treated as "not deprecated" rather than printed as `@deprecated(reason: "")`.
Deprecation is schema shape, so it changes the artifact fingerprint: `gqlize check` will report an
existing artifact stale and it needs a rebuild.

### Soft delete (`paranoid`)

A **paranoid** model is never really deleted: `delete` stamps a `deletedAt` column instead of
removing the row, and every read filters the stamped rows out. Nothing else about the model
changes — this is Sequelize's `paranoid` option, passed straight through.

Turn it on for **one model** in its `options`:

```ts
db.addDefinition({
  name: "Comment",
  define: { body: { type: Sequelize.STRING, allowNull: false } },
  options: { paranoid: true },
});
```

Turn it on for **every model** with the Sequelize adapter's `defaultModel`, which supplies the
options each definition starts from:

```ts
db.registerAdapter(
  new SequelizeAdapter(
    { defaultModel: { timestamps: true, paranoid: true } },
    { dialect: "sqlite" },
  ),
  "sqlite",
);
```

A definition's own `options` are merged **over** `defaultModel`, so a single model opts back out
without disturbing the rest:

```ts
db.addDefinition({
  name: "AuditLog",
  define: { line: { type: Sequelize.STRING } },
  options: { paranoid: false },   // hard deletes, even under the global default above
});
```

`defaultModel` is per adapter, so a setup registering several Sequelize adapters sets it on each
one. Its field-level counterpart is `defaultAttr`, merged the same way under every column's
definition.

> `paranoid: true` needs `timestamps` — the flag is only meaningful because `deletedAt` exists.
> Sequelize accepts `{paranoid: true, timestamps: false}` and then defines no such column, so
> deletes are permanent while the model claims otherwise. gqlize warns on `console.warn` when a
> definition resolves that way, and treats the model as not soft-deleting: no `deleted` argument
> and no `restore`. Generated `belongsToMany` join tables are pinned to `paranoid: false` for the
> same reason, so a global default cannot land them in that state.

What soft delete adds to the schema is covered under
[Soft-deleted rows (`deleted`)](#soft-deleted-rows-deleted) and
[Restoring soft-deleted rows](#restoring-soft-deleted-rows).

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

### Build-time validation (`options.validate`)

`createSchema` ends by running graphql's own `validateSchema` and throwing if the result is not a
valid schema. This matters more than it sounds. graphql validates lazily — once per *execution*,
cached on the schema — and returns the same error list for every operation, so one malformed field
does not fail only the query that selects it:

```
# before: a bad field in options.root, and every unrelated query dies at request time
{ "errors": [{ "message": "Subscription.subjectChanged field type must be Output Type but got: undefined." }] }
```

Now that is an error from `createSchema`, naming the coordinate *and* pointing at the likely cause:

```
Error: gqlize: the generated schema is not a valid GraphQL schema:
  - Subscription.subjectChanged field type must be Output Type but got: undefined.
Most often this is a type written into `options.root`, `options.extend` or a definition's
`override` / `expose` block. Pass `validate: false` to skip this check.
```

graphql's own error objects stay reachable on `error.errors`. `materializeSchema` and `loadSchema`
run the same check, where it matters more still — an artifact is loaded at boot, so an invalid one
would otherwise get as far as serving traffic.

The check walks the whole type map. If you build many permission profiles per process and would
rather pay for it once in CI, turn it off at runtime:

```ts
const schema = await createSchema(db, { validate: false });
```

`gqlize build` and `gqlize check` construct a schema the same way, so they are the strict form.

---

## 5. Pre-generated schema artifacts

`createSchema` builds the whole type graph on every boot. You can instead generate it once into a
JSON artifact — something you can review in a pull request, diff in CI, and load at startup.

The package ships a `gqlize` binary:

```sh
npx gqlize build      # -> ./gqlize.schema.json (+ an optional SDL sidecar)
npx gqlize check      # exit 1 if the artifact no longer matches your definitions
npx gqlize print      # the schema as SDL — live, or --from-artifact
```

It reads a config file (`gqlize.config.ts`, discovered by walking up from the cwd):

```ts
// gqlize.config.ts
import { defineConfig } from "@azerothian/gqlize/cli/types";
import { buildDb } from "./src/db";

export default defineConfig({
  orm: () => buildDb(),                // must return an initialise()d + sync()ed instance
  out: "./generated/schema.json",
  sdl: "./generated/schema.graphql",   // optional sidecar, for codegen and CI diffs
});
```

Then load it instead of building:

```ts
import { loadSchema } from "@azerothian/gqlize/snapshot";

const db = await buildDb();
const schema = await loadSchema("./generated/schema.json", db, { permission });
```

Three things are worth understanding before you adopt this:

- **The ormize instance is still required.** It *is* the resolution engine — the artifact replaces
  only the type-construction step, not the data access underneath it. `loadSchema` binds the
  serialized field descriptors back onto your live definitions.
- **Build it for reviewability and determinism, not for boot speed.** Schema generation is a small
  part of a boot dominated by loading the driver and running `initialise()`/`sync()`, and the loader
  still pays those. Measure before claiming a startup win.
- **The artifact is JSON, not SDL, and that matters.** `printSchema` discards enum *internal* values
  — the `["name", "ASC"]` payload behind `PostOrderBy.nameASC` — and never prints applied
  directives. An SDL round-trip loses both silently, so SDL is only ever a secondary artifact.

Every artifact carries a fingerprint of the definitions it was built from, and a mismatch throws at
load. During development you usually want the artifact to get out of your way instead:

```ts
const schema = await loadSchema("./generated/schema.json", db, {
  permission,
  onMismatch: process.env.NODE_ENV === "production" ? "throw" : "rebuild",
});
```

`"rebuild"` warns and falls back to a live `createSchema`, so editing a model mid-iteration does not
force a rebuild step. The other modes are `"throw"` (the default) and `"warn"`.

One caveat to know up front: the fingerprint **cannot see permission changes**, because
`options.permission` is a bag of closures and closures cannot be hashed. That is what
`gqlize check` is for — by default it rebuilds the schema live and diffs the sorted SDL, which
catches permission drift and everything else. Run it in CI.

The same is true of `options.id` and `options.cursor`, with a sharper failure: an artifact built
with codecs and loaded without them still *resolves* — it just hands clients a different ID and
cursor format than the one it accepts back. The fingerprint records whether each was configured,
so that case is caught; to also catch one codec swapped for another of the same shape, name them
with `idProfile` / `cursorProfile` at build and at load, the way `permissionProfile` names a
permission set.

See the [`@azerothian/gqlize` README](../packages/gqlize/README.md#pre-generated-schema-artifacts)
for permission profiles, custom scalars, `extendFactory`, and the full programmatic API
(`snapshotSchema`, `materializeSchema`, `fingerprintDefinitions`), and
[`examples/gqlize-basic`](../examples/gqlize-basic) for a working config and an artifact-served
server.

---

## 6. Querying

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

The generated shape, for a model `Post`:

```graphql
type PostList {
  pageInfo: PageInfo!
  total: Int
  edges: [PostEdge!]!
}

type PostEdge {
  node: Post
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

The non-null marks are what the Relay Connections spec requires (`pageInfo` and both page flags),
plus `edges` and `cursor`, which gqlize's resolver always populates. **This changes what client
codegen generates for you**: Relay, graphql-codegen and Apollo's `relayStylePagination` previously
emitted `pageInfo` as optional and both flags as `boolean | null`, forcing null checks against
values the server has no way to produce. Those checks are now dead code, and TypeScript will say so.

`total` and `edges.node` stay nullable on purpose — `total` is a separate COUNT that gqlize may skip
when nothing selects it, and a row can be deleted between the page query and the per-edge node
resolve. Every field above was nullable in 6.x; see
[the migration note](migration-6-to-7.md#relay-connection-fields-are-non-null).

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

An exposed instance method can contribute a filter the same way, without declaring the operator
separately — see [The declarative keys](#the-declarative-keys) (`where`).

### Ordering (`orderBy`)

`orderBy` is an enum named `{Model}OrderBy` with `{field}ASC` / `{field}DESC` values:

```graphql
Post(orderBy: titleASC)  { edges { node { title } } }
Post(orderBy: createdAtDESC) { edges { node { title } } }
```

Columns are not the only members: an exposed instance method that declares an `orderBy` adds its
own `{name}ASC` / `{name}DESC` pair to the enum — see
[The declarative keys](#the-declarative-keys).

### Pagination (cursors)

Cursor arguments: `first`, `after`, `last`, `before`. Cursors are opaque strings you copy from
`edges[].cursor` (or `pageInfo.startCursor`/`endCursor`) — by default a base64 blob carrying the
connection's name and the row's index, though the format is
[yours to choose](#custom-id--cursor-formats). Whatever the format, a cursor minted by one
connection is rejected by another, and a malformed one raises `Invalid cursor`:

```graphql
# page 1
query { models { Post(first: 10) { edges { cursor node { id } } pageInfo { endCursor hasNextPage } } } }

# page 2 — pass the previous page's cursor
query { models { Post(first: 10, after: "eyJpZCI6..." ) { edges { cursor node { id } } } } }
```

`cursor` is `String!` and `pageInfo` is `PageInfo!` with `hasNextPage` / `hasPreviousPage` both
`Boolean!`, so a paging loop needs no null checks on the values it drives off. `startCursor` and
`endCursor` are still nullable — an empty page has no first or last edge to name — so guard the
"is there another page" decision on `hasNextPage`, not on the cursor being present.

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

### Soft-deleted rows (`deleted`)

Every list field on a [paranoid](#soft-delete-paranoid) model takes a `deleted` argument:

| Value | Rows returned |
| --- | --- |
| `EXCLUDE` | live rows only — the default, and what you get by omitting the argument |
| `INCLUDE` | live and soft-deleted rows together |
| `ONLY` | soft-deleted rows on their own — a trash view |

```graphql
# everything, deleted or not
query { models { Comment(deleted: INCLUDE) { total edges { node { id body deletedAt } } } } }

# the trash: what was deleted, newest first
query { models { Comment(deleted: ONLY, orderBy: [deletedAtDESC], first: 20) {
  total edges { node { id body deletedAt } } } } }
```

`total` follows the same filter as `edges`, so a connection never counts one set of rows and
returns another.

The argument applies to **one query node**, not to the request. A nested connection keeps its own
setting, so a parent asking for deleted rows still gets live children unless the child asks too:

```graphql
query { models { Post(deleted: INCLUDE) { edges { node {
  title
  comments(deleted: ONLY) { total edges { node { body } } }   # deleted comments of every post
} } } } }
```

The same field is available inside an explicit `include`:

```graphql
query { models { Post(include: [{ comments: { deleted: INCLUDE, separate: true } }]) {
  edges { node { comments { total edges { node { body } } } } } } } }
```

`deletedAt` is an ordinary column once paranoid is on, so it can be selected, filtered in `where`,
and named in `orderBy` like any other field.

Two things soft delete does *not* reach: `node(id:)` never resolves a deleted row, and
`belongsTo` / `hasOne` fields have no `deleted` argument — a deleted single-relation target reads
as `null`. `update` and `delete` also skip deleted rows; restore first, then write.

The argument is gated by the `queryDeleted` permission, and is absent from the schema entirely for
a caller who is denied it — see [Permissions](#8-permissions).

### Global IDs & `node`

Primary/foreign keys are Relay global IDs — by default the base64 of `Type:id`. Fetch any object
by its global ID via `node`:

```graphql
query ($id: ID!) {
  node(id: $id) {
    id
    __typename
    ... on Post { title }
  }
}
```

The type half is checked, not just carried. A global ID minted for `Post` handed to a field that
expects a `Task` key is left undecoded rather than silently filtering on the raw number underneath
it, so it matches nothing instead of matching an unrelated row. `node(id:)` is the one place a
global ID may name any type — there the ID *is* the type declaration.

A value that is not a global ID at all — a raw `"42"` typed into a filter or a mutation input —
is passed through untouched, so it still means the key it looks like.

### Custom ID & cursor formats

Both formats above are defaults, not fixtures. `options.id` and `options.cursor` take a codec, and
everything gqlize mints and reads goes through it — the `id` field, every foreign key, filters,
mutation inputs, `node(id:)`, and `edges[].cursor`:

```ts
import { createSchema, prefixIdCodec, plainCursorCodec } from "@azerothian/gqlize";

const schema = await createSchema(db, {
  id: prefixIdCodec({ prefixes: { Post: "PST", Author: "AUT" }, pad: 6 }),
  cursor: plainCursorCodec(),
});
// Post row 1 is now "PST000001" rather than "UG9zdDox"
```

Shipped codecs:

| Codec | Format | Notes |
| --- | --- | --- |
| `relayIdCodec()` | base64 `Type:id` | the default |
| `prefixIdCodec({ prefixes, pad })` | `PST000001` | readable and sortable; every exposed model needs a prefix |
| `rawIdCodec()` | the key itself | see the `node` caveat below |
| `relayCursorCodec()` | base64 `["Connection", index]` | the default |
| `plainCursorCodec()` | `Connection:index` | readable |
| `signedCursorCodec({ secret })` | `Connection:index.<hmac>` | rejects a cursor whose index was edited |
| `fallbackCursorCodec(next, ...previous)` | mints `next`, reads any | for rolling deploys |

Two things to know before you swap one in:

- **`rawIdCodec` drops `node(id:)`.** A raw key cannot say what type it belongs to, so the root
  `node` field is omitted from the schema at build time (with a warning) rather than left in it to
  return `null` for every lookup. Any codec you write yourself can declare the same by setting
  `carriesType: false`.
- **Changing a format is a breaking change for clients.** IDs and cursors clients have already
  stored stop resolving. `fallbackCursorCodec` exists for exactly this: deploy it reading both
  formats and minting only the new one, then drop the old codec once the old cursors have aged out.

Writing your own is two functions. `encode` mints, `decode` returns `null` for anything that is not
one of yours — that `null` is what leaves a raw key in a filter alone:

```ts
import type { IdCodec } from "@azerothian/gqlize";

const hexIdCodec: IdCodec = {
  carriesType: true,
  encode: ({ type, id }) => Buffer.from(`${type}:${id}`).toString("hex"),
  decode: ({ value, type }) => {
    if (!/^(?:[0-9a-f]{2})+$/.test(value)) { return null; }
    const [name, ...rest] = Buffer.from(value, "hex").toString("utf8").split(":");
    const id = rest.join(":");
    if (!name || !id) { return null; }
    // The check that stops a Post ID from filtering a Task foreign key. `type`
    // is the type the field points at; `node(id:)` passes none, because there
    // the ID is what names the type.
    if (type && name !== type) { return null; }
    return { type: name, id };
  },
};
```

`decode` should never throw — return `null` and let the caller decide whether that is an error or
just a value it does not own.

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

#### The declarative keys

Beyond `type`/`args`/`before`/`after`, an exposed method may declare what it needs loaded and
how it shapes the query it is selected in. Every key is optional, and every key is available on
all four `expose.{classMethods,instanceMethods}.{query,mutations}` targets — but `fields`,
`include`, `input`, `orderBy` and `where` only *mean* something for
`instanceMethods.query`, because only there does a method run against a row inside a query the
engine also built.

| Key | Shape | What it does |
| --- | --- | --- |
| `fields` | `string[]` \| `"*"` | Columns the method reads off `this`. Unioned into the projection. `"*"` opts the query out of narrowing entirely. |
| `include` | `{ [relName]: Partial<IncludeDescriptor> }` | Relations the method reads. Merged into the include plan. `{ items: {} }` is enough; `{ items: { required: true } }` shapes the join. |
| `input` | `(params, ctx) => params` | Shape the built query. Receives the same `params` object `definition.before` gets. |
| `output` | `(value, ctx) => any` | Produce or format the field's value. A method with an `output` needs no implementation at all. |
| `orderBy` | `string[]` \| `(direction, ctx) => OrderEntry[]` | Contribute `<name>ASC` / `<name>DESC` to the model's `orderBy` enum. |
| `where` | `string` \| `{ type?, operators?, resolve }` | Contribute a nested operator object to the model's `where` input. `type` is the GraphQL input type the operators take, defaulting to `GraphQLString`; `string` borrows a real column's type instead. |

`ctx` carries `{ args, context, info, modelDefinition, source }` — the args the field was
selected with, the request context, and the definition the method belongs to.

**`fields` and `include` — loading what the method reads.**
gqlize narrows the projection to the columns the selection set actually asked for. An exposed
method is a *field name*, not a column, so without a declaration the columns it reads off `this`
are simply not there:

```ts
instanceMethods: {
  query: {
    // Reads `this.firstName` / `this.lastName`, which the client need not select.
    fullName: { type: GraphQLString, fields: ["firstName", "lastName"] },
    // Reads a relation.
    petNames: { type: new GraphQLList(GraphQLString), include: { pets: {} } },
    // Reads the whole row; opt out of narrowing.
    audit:    { type: GraphQLString, fields: "*" },
  },
},
```

The widening applies only when the method is actually selected, and it is additive — it adds to
what the selection set asked for rather than replacing it.

**`input` and `output` — shaping the query and the value.**

```ts
recent: {
  type: GraphQLString,
  args: { since: { type: GraphQLString } },
  // Narrow the query this field was selected in.
  input: (params, { args }) => ({ ...params, where: { ...params.where, createdAt: { [Op.gt]: args.since } } }),
  // Produce the value. No `instanceMethods.recent` implementation is needed.
  output: (value, { source }) => source.get("title").toUpperCase(),
},
```

Hooks run in a fixed order: `fields`/`include` merge into the projection first, then
`definition.before`, then each selected method's `input` in declaration order — so a method's
`input` sees the final options and gets the last word. `output` then produces the field value,
and `after` post-hooks it.

Selecting the same method twice under different aliases runs `input` once per occurrence (each
seeing its own args) and `output` once per row per occurrence.

**`orderBy` and `where` — sorting and filtering on a computed field.**

```ts
fullName: {
  type: GraphQLString,
  fields: ["firstName", "lastName"],
  output: (v, { source }) => `${source.get("firstName")} ${source.get("lastName")}`,
  // `fullNameASC` / `fullNameDESC` join the orderBy enum.
  orderBy: ["lastName", "firstName"],
  // `where: { fullName: { eq: "John Smith" } }` becomes a real query fragment.
  where: {
    operators: ["eq"],
    resolve(whereObject, options, value) {
      const [first, last] = String(value[Op.eq]).split(" ");
      return { firstName: { [Op.eq]: first }, lastName: { [Op.eq]: last } };
    },
  },
},

// The portable short form: apply the operator object to a real column instead.
surname: { type: GraphQLString, fields: ["lastName"], where: "lastName" },
```

`orderBy` may also be a function, for expressions the backend understands:

```ts
nameLength: {
  type: GraphQLInt,
  fields: ["firstName", "lastName"],
  orderBy: (direction) => [[Sequelize.literal(`LENGTH("firstName" || ' ' || "lastName")`), direction]],
},
```

`resolve` receives the operator object already keyed by the backend's operator symbols — the
same shape a `whereOperators` entry gets — and returns a where fragment, so a computed filter
composes with `and`/`or` and works at include depth exactly as it does at the root.

> **Push-down only.** `orderBy` and `where` must produce *query fragments*. gqlize will not
> sort or filter in memory after the fact: post-filtering would break `first`/`last` and cursor
> offsets and desync `total`, and fetch-all-then-filter is a DoS vector on precisely the models
> where you would reach for it. If an ordering or filter cannot be expressed against the
> backend, don't declare it.

> **Declared `fields` are server-side.** `fields: ["passwordHash"]` loads a column the client's
> selection set could never reach. That is deliberate — the definition author wrote both the
> declaration and the method that reads it — but it is worth knowing rather than discovering.

> **The portable `where: "column"` form is dropped when that column is not filterable.**
> It borrows the named column's value type, so if permissions (or the adapter — Valkey can only
> filter what it has indexed) left that column out of the model's `where` input, the computed
> alias disappears with it rather than falling back to a default type. Filterability is a boolean
> oracle on the value either way, and a denied column must not become reachable through a
> computed name. The object form is unaffected: it declares its own `type` and its `resolve`
> decides what it touches.

**Permissions.** The ordering and filtering contributions are gated by
`permission.queryInstanceMethods`: a method the caller may not select contributes no enum
value and no `where` field, because sortability and filterability each leak a denied field's
value. See [§8 Permissions](#8-permissions).

**Name collisions.** An exposed instance method cannot share a name with a column, and a name
cannot appear in both `instanceMethods.query` and `instanceMethods.mutations` — the generated
type, `orderBy` enum and `where` input each have one slot for it, and both instance-method
targets resolve to the same implementation. Either case fails the schema build with an explicit
error.

---

## 7. Mutations

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

### Restoring soft-deleted rows

A [paranoid](#soft-delete-paranoid) model also gets a `restore` argument, which clears `deletedAt`
on the rows a filter names and returns them. It takes the same filter type as `delete`
(`[GQLTQuery{Model}Where]`):

```graphql
mutation { models { Comment(restore: { body: { eq: "oops" } }) { id body } } }
mutation ($where: [GQLTQueryCommentWhere]) { models { Comment(restore: $where) { id } } }
```

The filter matches against soft-deleted rows only, so restoring something that was never deleted
is a no-op returning an empty list. Restore counts as an **update** throughout: `permission.scope`
gates it with the `update` operation, the `beforeRestore` / `beforeBulkRestore` hooks are scoped
as updates, and `after` receives `Events.MUTATION_UPDATE`.

`restore` is gated by the `mutationRestore` permission, and appears only on models that actually
soft delete.

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

### Instance-method transforms (`apply`)

`expose.instanceMethods.mutations` declares instance methods that reshape a record on its way to
a write. They surface as an `apply` argument alongside `create` / `update`:

```ts
db.addDefinition({
  name: "Post",
  expose: {
    instanceMethods: {
      mutations: {
        appendSuffix: { args: { suffix: { type: new GraphQLNonNull(GraphQLString) } } },
        markChecked: {},   // no args → a Boolean flag
      },
    },
  },
  options: {
    instanceMethods: {
      // Direct-write flavour: mutate `this`, return nothing.
      appendSuffix({ suffix }) { this.name = `${this.name}${suffix}`; },
      // Returned-values flavour: return a partial input to merge.
      markChecked() { return { checked: true }; },
    },
  },
});
```

```graphql
mutation {
  models {
    Post(
      create: { title: "Hello" },
      apply: { appendSuffix: { suffix: "!" }, markChecked: true }
    ) { id title checked }
  }
}
```

A transform declaring args takes its arg bag; one declaring none takes `Boolean`, and only
`true` runs it. Both flavours work on create and on update: on create `this` is the pending
values object, on update it is the live row — and direct writes to it are captured and
persisted, so `this.name = …` is not silently dropped. Transforms run in the order named, each
seeing what the previous one wrote.

Transforms run **after** `definition.before` and immediately before the adapter persists, so a
transform wins over a value that hook set.

> **Transforms are transactional.** An instance-method transform runs inside the mutation's own
> transaction, so a throw rolls the whole mutation back — including any nested relationship
> writes. That is the point: it means a transform can veto a write. It also means a transform
> must not reach outside the transaction — no third-party call whose effects the rollback
> cannot undo.

Transforms are gated by `permission.mutationInstanceMethods`; a denied transform contributes no
field to `apply`. See [§8 Permissions](#8-permissions).

---

## 8. Permissions

Pass a `permission` object as the second argument to `createSchema`. Each key below is a predicate
returning a boolean; returning falsy removes the corresponding element from the schema. The one
exception is `scope`, which returns a filter rather than a decision and runs per request rather than
per schema — see [Row-level scope](#row-level-scope-permissionscope) at the end of this section.

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
    mutationRestore: (modelName) => true,                       // hide `restore` on a paranoid model
    mutationCreateInput: (modelName, fieldName) => true,        // hide a create-input field
    mutationUpdateInput: (modelName, fieldName) => true,
    queryDeleted: (modelName) => true,                          // hide the `deleted` argument
    relationship: (modelName, relName, targetName) => true,
    queryClassMethods:    (modelName, methodName) => true,
    mutationClassMethods: (modelName, methodName) => true,
    queryInstanceMethods: (modelName, methodName) => true,
    mutationInstanceMethods: (modelName, methodName) => true,   // hide a transform from `apply`
    queryExtension:    (fieldName) => true,                     // hide an `options.extend.query` field
    mutationExtension: (fieldName) => true,                     // hide an `options.extend.mutation` field
    options: { /* shared value passed to every predicate */ },
  },
});
```

`queryExtension` / `mutationExtension` are the odd pair: their first argument is the
**extend field key** from `options.extend.query` / `options.extend.mutation`, not a model
name. There is no `subscription` predicate — subscriptions are not implemented, so such a
predicate would never be called.

A key that is not in this list is not a predicate at all, and an absent predicate means
**allow** — so a typo silently widens the schema rather than narrowing it. `createSchema`
types `options`, which turns a misspelled key into a compile error, and warns on
`console.warn` at build time for callers who aren't typechecking.

**Denying a model also drops the relationships pointing at it.** Removing a model with
`permission.model`, or emptying it of every field with `permission.field`, leaves nothing for a
relationship to point at — so every relationship field targeting it disappears too, silently and
by design. That is how the denial propagates, but it means a missing relationship field is not
always a bug in the relationship: check the target's permissions first. The one case that *does*
warn on `console.warn` is a relationship whose target has no definition behind it at all, which
is an authoring mistake rather than a denial.

**Role-based helper.** `createRoleBasedPermissions(role, rules, options?)` compiles an
allow/deny rules tree into the `permission` object above (defaults to deny):

```ts
import { createRoleBasedPermissions } from "@azerothian/utilize"; // named export via the barrel

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

### Row-level scope (`permission.scope`)

Every key above answers *does this surface exist*, at schema-build time, with a boolean. `scope`
answers the other question — *which rows* — and it is the only key consulted **per request** rather
than once per schema. That is why it is not in the list above, and why it may be `async`: resolving
group membership is a lookup.

```ts
const schema = await createSchema(db, {
  permission: {
    scope: (defName, operation, options, context) => {
      if (defName !== "Task") {
        return undefined;                          // no opinion — this model is unscoped
      }
      const user = context.user;
      if (!user) {
        return false;                              // deny outright
      }
      if (operation === "create") {
        return { set: { ownerId: user.id } };      // force a value, there is no `where` to filter
      }
      return { where: { ownerId: { eq: user.id } } };
    },
  },
});
```

`operation` is `"read" | "create" | "update" | "delete"`. `options` is the shared
`permission.options` bag, fixed for the life of the schema; `context` is the per-request context —
the GraphQL context under gqlize, `{req}` under nestize, the activity context under temporalize.

**Return values.** The two falsy-looking ones mean opposite things, which is the sharpest edge in
the feature:

| Return | Meaning |
| --- | --- |
| `undefined` | No opinion, so **no restriction** — matching every other key, where an absent predicate allows. |
| `false` | Deny. Reads return nothing; writes follow `onScopeMiss`. |
| `{ownerId: {eq: "u1"}}` | A bare filter in the caller's `where` vocabulary, AND-ed into the operation's filter. |
| `{where, set, native}` | The long form: `where` filters, `set` forces field values on a create or update, `native` is an adapter-native escape hatch (below). |

A returned filter is not a boolean, which is why `scope` never travels through the same `isAllowed`
helper the other keys use — `!!filter` is `true`, and a scope coerced that way evaporates into an
unrestricted query.

**Fail-closed, asymmetrically.** An **absent** `scope` key means unscoped. This key postdates every
deployment that does not set it, and denying every row on their behalf would be the wrong direction
of surprise. A **present** predicate that throws is a **deny** — a configured predicate failing is
not a reason to widen the query. The exception is `ScopeConfigurationError`, which is rethrown: a
scope that cannot be *expressed* (an `or` on an adapter with no way to AND two native filters, a
`like` bound into a raw-SQL `:scope…` parameter) is a configuration bug, and reporting it as an empty
page is how it goes unnoticed for a year.

**Where it applies.** Every read funnels through one chokepoint, so a single predicate covers the
root list, `total`, `node(id:)`, relationship fields (eager-loaded and lazy alike), nestize's
list/one/count and temporalize's `findAll` / `findOne` / `findByPk` / `count`. Writes are scoped in
four places, because a read scope alone is a false sense of security — a caller who cannot *see* a
row can still `update(where: {id: X})` it:

| Write | How |
| --- | --- |
| `create` | `set` forces the scope's values, applied after `definition.override`, so the client cannot supply them. |
| `update` | `where` narrows what is matched, and `set` is re-imposed on what is written. |
| `delete` | `where` narrows what is matched. |
| `select` | The relationship sub-mutation path — it writes no field of its own but reaches rows through a `where`, so a layer that scoped only update and delete would leave it open. |

The eight nested relationship verbs inherit through the same two helpers those paths use. A write
that would move a row *out* of scope is re-checked after the fact and refused.

**`onScopeMiss`.** By default a write the scope denies outright reports the same nothing an unscoped
write reports for a row that does not exist:

```ts
const schema = await createSchema(db, { permission: { scope }, onScopeMiss: "throw" });
```

`"empty"` (the default) keeps the two indistinguishable, since a distinguishable refusal is itself a
read of the scoped-out row. `"throw"` trades that for a loud one, which is the better call where the
callers are internal.

**What a scope does not hide.** Listed rather than left silent, so a reviewer can see they were
priced in rather than missed. A scope filters rows; it does not make a scoped-out row's *existence*
unobservable, and these channels remain:

- a create whose unique-constraint violation proves a row with that key already exists;
- a foreign-key violation from an `add` / `set` verb naming a scoped-out row;
- `onScopeMiss: "throw"`, which is opt-in for exactly this reason;
- timing.

Closing those needs something other than a `where`. The two that are cheap to close: leave
`onScopeMiss` at `"empty"`, and think twice before putting a unique constraint on a caller-chosen
value of a scoped model.

**Surfaces the engine cannot reach.** A class method, an instance method, an `options.extend.query`
/ `.mutation` field or a raw-SQL class method runs your code holding the model directly, so there is
no filter for the engine to merge into and no hook underneath that knows a request is happening.
When a `scope` is configured, every one of them must declare itself or the build reports it — route
the work back through the orm (best, and needs nothing here), or say which of the other two it is:

```ts
import { scopeAware, unscoped } from "@azerothian/utilize/gate";

options: {
  classMethods: {
    // Applies the scope itself. The engine hands it `context.scopeFor(defName, operation)`
    // and cannot verify it was used — which is why the claim has to be explicit and greppable.
    recentFor: scopeAware(async function(args, context) {
      const scope = await context.scopeFor("Task", "read");
      // …
    }),
    // An admission, sitting in the diff next to the code it excuses.
    systemTotals: unscoped(async function() { /* … */ }),
  },
}
```

Raw SQL gets the sharpest form, because a statement is text by the time it reaches the driver and
cannot be rewritten. The engine binds the resolved scope into named parameters the query has to
reserve, and a raw method on a scoped model whose text never mentions one **does not build**:

```ts
classMethods: {
  overdue: {
    query: `SELECT * FROM "Task"
             WHERE "due" < NOW()
               AND (:scopeOwnerId IS NULL OR "ownerId" = :scopeOwnerId)`,
  },
}
```

`:scopeOwnerId` binds whatever the scope pins `ownerId` to, and `null` where it pins nothing — which
is what the permissive `:scopeOwnerId IS NULL OR` half is for. Omit that half and the query returns
nothing, because `= NULL` matches no row; failing in that direction is deliberate. A parameter can
carry an equality and nothing else, so a scope whose filter needs `or`, `not`, `in` or `like` raises
a `ScopeConfigurationError` rather than binding half of itself.

**`native`.** `{native: …}` is merged in the adapter's own filter vocabulary rather than the portable
one, which makes it **adapter-locking**: a definition that later changes backend, or a model reached
across a cross-adapter relationship, silently loses what the escape hatch was expressing. Reach for
it only where the portable `where` genuinely cannot say what you mean.

**Role-based sugar.** `createRoleBasedPermissions` compiles `scope` from the same rules tree, with
`own` / `group` / `tenant` / `none` leaves and an optional per-operation split:

```ts
const permission = createRoleBasedPermissions("member", {
  member: {
    query: "allow",
    model: { Task: "allow", Project: "allow", Tag: "allow" },
    scope: {
      Task:    { own: "ownerId" },                         // filters reads, forces creates
      Project: { read: { group: "groupId" }, write: "deny" },
      Tag:     "none",                                     // explicitly unscoped
    },
  },
}, { principal: (context) => context.user });
```

`own` compares a field to the principal's `id`, `tenant` to its `tenantId`, `group` to a *list* on
it (`groupIds`); the long form `{own: {field: "ownerId", from: "userId"}}` spells both sides out.
`any` and `all` combine leaves. `read` / `write` split the operations, and an explicit `update`
beats the `write` it falls under.

Two things are deliberately unlike the rest of the rules tree. `defaultDeny` does **not** apply to
`scope`, and `"none"` has to be written out, because an absent `scope` already means unscoped —
without an explicit spelling, "this role sees everything" and "nobody has configured this yet" would
be the same tree. And a `group` leaf denies when the principal belongs to no groups rather than
compiling to `{in: []}`, which is a deny that reads like a bug; a principal the reader cannot find
at all is likewise a deny.

---

## 9. Hooks

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
`db.addHook(name, fn)`. Some hook names — `beforeQuery`/`afterQuery`,
`beforeConnect`/`afterConnect`, `beforeDefine`/`afterDefine`, `beforeInit`/`afterInit` and
`beforeBulkSync`/`afterBulkSync` — fire off the Sequelize **instance**, not a model, so they
are available *only* this way; putting one in a definition's `options.hooks` warns and is
ignored, because a model would never fire it. The count-only query path additionally fires `beforeCount` and a
gqlize-level `afterCount(total)` (which may transform the returned count).

---

## 10. Custom scalars & JSON columns

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

## 11. Multiple data sources

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

**Cross-adapter key columns must be declared by hand.** Within one adapter, a native association
creates its own foreign key as a side effect, so the column need not appear in `define`. Across
adapters there is no association to do that: ormize reads the key column itself to stitch the two
sides together, and it cannot create a column in someone else's datastore. Declare it explicitly
on whichever model holds it:

```ts
db.addDefinition({
  name: "Post", datasource: "pg",
  define: { title: { type: Sequelize.STRING } },
  relationships: [
    { type: "hasMany", model: "Audit", name: "audits", options: { foreignKey: "postId" } },
  ],
});

db.addDefinition({
  name: "Audit", datasource: "sqlite",
  define: {
    action: { type: Sequelize.STRING },
    postId: { type: Sequelize.INTEGER },   // required: `pg` cannot create a column in `sqlite`
  },
});
```

Which side holds the key follows the relationship type: `belongsTo` keeps `foreignKey` on the
source and `targetKey` on the target; `hasMany`/`hasOne` keep `sourceKey` on the source and
`foreignKey` on each target; `belongsToMany` puts `foreignKey` and `otherKey` on the join model
and `sourceKey`/`targetKey` on the two ends.

`initialise()` validates all of them in a pass once every relationship is wired, and throws
naming the relationship, the option that produced the name, and the fields the model actually
has — rather than letting it wire cleanly and fail at the first query as a raw
`no such column: Audit.postId`. Same-adapter relationships are deliberately not checked, since
the association creates the column.

---

## 12. Transactions & async context

### Single-adapter atomicity

A create/update/delete and its nested relationship writes already run atomically: each top-level
mutation is auto-wrapped in a transaction on its model's adapter, so a nested failure rolls the
whole operation back. No code needed.

### Coordinated cross-adapter transactions

Wrap several operations — on one adapter or several — in `orm.transaction(fn)` to make them one
unit of work. It lazily opens a transaction on each adapter it touches, commits them all on
success, and **rolls them all back if `fn` throws** — even across separate databases:

```ts
await orm.transaction(async () => {
  await orm.processCreate("Order",   null, { input: { ref: "ORD-1" } }, {}, undefined);        // sqlite
  await orm.processCreate("Payment", null, { input: { orderRef: "ORD-1", amount: 100 } }, {}, undefined); // pg
});
// If the Postgres write fails, the SQLite Order is rolled back too.
```

Nested `orm.transaction(...)` calls join the active one rather than opening a new transaction.

> **Best-effort, not two-phase commit.** A failure *during the work* rolls everything back cleanly.
> It is not XA/2PC: a failure during the final commit phase, after some adapters have already
> committed, cannot be undone (SQLite/Postgres offer no distributed transaction). For the common
> validate → write-several-stores → commit flow, the mid-work rollback guarantee is what matters.

### Async context tracking

`orm.runWithContext(context, fn)` makes `context` ambient for the duration of `fn` (propagated via
`AsyncLocalStorage`), readable anywhere via `orm.getContext()` — including inside
`definition.before`/`after` hooks — without threading it through every call:

```ts
await orm.runWithContext({ user: currentUser }, async () => {
  await orm.transaction(async () => { /* hooks here can read orm.getContext() */ });
});
```

A full runnable demo (SQLite + in-memory Postgres via PGlite) lives in
[`examples/cross-adapter-transaction`](../examples/cross-adapter-transaction).

---

## 13. The Valkey / Redis adapter

`@azerothian/ormize-adapter-valkey` stores objects as typed JSON in Valkey/Redis. Unlike a SQL
backend it **never scans the keyspace** — retrieval is driven entirely by index/mapping structures
the adapter maintains itself.

```ts
import { Ormize } from "@azerothian/ormize";
import ValkeyAdapter from "@azerothian/ormize-adapter-valkey";
import IORedis from "ioredis";

const orm = new Ormize();
orm.registerAdapter(new ValkeyAdapter({ prefix: "app" }, new IORedis(url)), "valkey");
```

**Indexes.** A field is searchable when it is a primary key, a `unique` field, a relationship foreign
key (auto-indexed), or marked `index: true` (or listed in a Sequelize-style `options.indexes`):

```ts
define: {
  id:    { type: DataTypes.UUID, primaryKey: true },
  email: { type: DataTypes.String, unique: true },   // unique index
  role:  { type: DataTypes.String, index: true },    // secondary index
  name:  { type: DataTypes.String },                 // NOT searchable
}
```

**Index-only `where`.** A query must reference at least one indexed field; the adapter intersects the
relevant index sets to build the candidate ids, then refines any non-indexed conditions in memory over
that bounded set. A `where` with only non-indexed fields is **rejected** (it will not scan). The
generated GraphQL `where`/`orderBy` types therefore expose only indexed fields. Relationship reads use
the foreign-key index map, so they are index-driven too.

**Expiry.** Get/set an object's TTL — and it cascades into the mappings, so an expired object is
excluded from (and purged out of) every index it belonged to:

```ts
const adapter = orm.getModelAdapter("Session");
await adapter.setExpiry("Session", id, 60_000); // 60s TTL, applied to the object AND its index entries
await adapter.getExpiry("Session", id);         // ms remaining
```

TTL can also be set at write time (`options.ttl`) or as a definition-level default (`options.ttl`).

**Transactions.** Inside `orm.transaction(...)`, Valkey writes buffer in a per-transaction overlay
(with read-your-writes) and apply atomically via `MULTI`/`EXEC` on commit, or discard on rollback — so
a Valkey adapter participates in cross-adapter transactions with true rollback.

**Relationships.** All four relation types work — hasOne/belongsTo/hasMany via foreign-key index maps
and belongsToMany via a join model (a normal indexed record, so `through` columns are supported).
Nested relationship-mutation input (`{tags: {create/add/set/remove/...}}`) works the same as on the
Sequelize adapter — the shared `__tests__/relations.test.ts` suite runs against both backends.

**Field metadata.** `description`, `args` and `resolve` on a `define` field behave the same here as
on the Sequelize adapter (see [Field arguments & field resolvers](#field-arguments--field-resolvers)),
`comment` included. All three used to be dropped by this adapter — so if you already author
`description`/`comment` on a Valkey-backed model, its GraphQL fields now gain those descriptions and
the artifact's `models` fingerprint changes; rebuild the artifact.

**Sequelize-style model API.** In addition to the manager pipeline (`orm.processCreate`/
`resolveFindAll`), the direct model/instance API works too, so a Valkey-backed model is used the same
way as a Sequelize one: static `orm.models.X.create/findAll/findOne/findByPk/count/update/destroy`,
instance `row.save/update/destroy/reload/get/toJSON`, definition `classMethods`/`instanceMethods`, and
Sequelize-cased relationship finders (`author.getPosts()`, `addPost`, `countPosts`, …). The shared
`__tests__/model-api.test.ts` suite asserts the same API on both adapters. (Direct static queries take
the Valkey filter DSL — plain equality `{ name: "x" }` or `{ name: { eq: "x" } }`.)

**Limitations:** composite multi-field indexes and cross-adapter relationships (a relation whose
target lives on a different adapter) are not supported. See the runnable
[`examples/valkey-basic`](../examples/valkey-basic).

---

*See [specifications.md](specifications.md) for the architecture, the adapter contract, and the
full generated-schema reference.*
