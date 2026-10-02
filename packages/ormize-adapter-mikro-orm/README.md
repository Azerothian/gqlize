# @azerothian/ormize-adapter-mikro-orm

A [MikroORM](https://mikro-orm.io) backend adapter for [`@azerothian/ormize`](../ormize).

The other adapters are handed an ormize `Definition` and build a native model from it. This one is
**inverted**: you hand it a MikroORM instance that already has its entities, and it derives the
definitions from that instance's own metadata. There is nothing to `define()`.

```ts
import { MikroORM } from "@mikro-orm/postgresql";
import { Ormize } from "@azerothian/ormize";
import { createSchema } from "@azerothian/gqlize";
import MikroAdapter from "@azerothian/ormize-adapter-mikro-orm";
import { User, Article, Tag } from "./entities";

const mikro = await MikroORM.init({ entities: [User, Article, Tag], /* … */ });

const db = new Ormize()
  .registerAdapter(new MikroAdapter<{ User: User; Article: Article; Tag: Tag }>(mikro));

await db.initialise();            // entities discovered here — no define() calls
const schema = await createSchema(db);

db.models.User.findAll();         // typed as Promise<User[]>
```

The entity map (`<{ User: User; … }>`) is optional and only affects types: it is what makes
`db.models.User` a `MikroModel<User>` instead of a loose handle. It is written out rather than
inferred from the entity list because `typeof User` carries `name: string`, not the literal
`"User"`, so there is no key to infer.

## What you get

- **Discovery, not declaration.** Every non-abstract entity becomes an ormize model: columns,
  nullability, defaults, comments, enums, arrays and all four relationship kinds come out of
  `orm.getMetadata()`. `@Property({ hidden: true })` becomes `ignoreFields`.
- **A schema with no database behind it.** MikroORM runs its own discovery at construction and this
  adapter opens nothing, so `initialise({ ddl: false })` plus `createSchema(db)` prints a full
  schema offline — see `__tests__/offline.test.ts`, which arms a tripwire on the connection.
- **Foreign keys as first-class fields.** MikroORM has no scalar property for a relation's key
  (`Article.author` *is* the key holder), so discovery synthesizes one — `authorId` — typed by what
  it points at. That is what gives it the right relay global id, and `where: { authorId: … }` works
  like any other column.
- **The full ormize runtime**: filters, ordering, cursor pagination, eager loading through
  `include`, all five mutation verbs, nested relationship mutations, hooks, row-level scope, and
  transactions.
- **Active-record-shaped API** on top of the Data Mapper: static
  `db.models.X.create/findAll/findOne/findByPk/count/update/destroy`, instance
  `row.save/update/destroy/reload/get/toJSON`, and relationship accessors
  (`author.getArticles()`, `addArticle`, `countArticles`, …) under the same names every other
  adapter uses.
- **Cross-adapter relationships**: one end on MikroORM, the other on Sequelize or Valkey.

## The EntityManager

Every call reads `mikro.em`, which already resolves to the host application's `RequestContext` fork
when one is active and to the root manager when not. Forking behind the host's back would discard
whatever it arranged, so the adapter does not — set up MikroORM's `RequestContext` middleware as you
normally would and it is honoured.

`orm.transaction(...)` forks explicitly. The transaction handle *is* a forked EntityManager, so a
nested mutation joins it with no further plumbing.

## Options

```ts
new MikroAdapter(mikro, {
  definitions: { … },              // per-entity Definition overrides, merged over what was derived
  entities: ["User", "Article"],   // restrict discovery; omit for every entity
  manageSchema: false,             // whether initialise()/sync()/reset() may issue DDL
  enablePostgresArrayOperators: false,
})
```

### `definitions` — the overrides

Discovery reads structure. It cannot know how a model should be *exposed*: `expose`, `comments`,
`deprecations`, `override`, the `before`/`after` hooks, class and instance methods, custom
where-operators and soft delete are all authored. This is where they go:

```ts
new MikroAdapter(mikro, {
  definitions: {
    User: {
      ignoreFields: ["passwordHash"],
      comments: { email: "Primary contact address" },
      expose: { instanceMethods: { query: { fullName: { type: GraphQLString } } } },
    },
  },
})
```

The merge is per key for `define`, `options`, `comments`, `deprecations` and `override`, and by name
for `ignoreFields` and `relationships` — so naming one column does not drop the other forty, and
adding one relationship does not drop the discovered ones.

### Soft delete

MikroORM has no soft delete of its own, so it is opt-in per entity:

```ts
definitions: { Article: { options: { paranoid: true, deletedAt: "deletedAt" } } }
```

The column must exist on the entity. With it, `delete` writes a timestamp instead of removing the
row, `restore` clears it, and the generated schema gains the `deleted` argument and the `restore`
mutation. A MikroORM global filter would be the more idiomatic mechanism, but a filter registered on
the instance would apply to the host application's own queries too — an adapter has to leave the
instance it was handed alone. That is also why `manageSchema` defaults to `false`: the schema
belongs to the host application, and an ormize call must not create or drop tables under it.

### Cross-adapter relationships

MikroORM cannot express a relationship whose other end is not one of its entities, so declare it
through the override. Give the entity a plain column for the key:

```ts
new MikroAdapter(mikro, {
  definitions: {
    Member: {
      relationships: [
        { type: "belongsTo", model: "Company", name: "company", options: { foreignKey: "companyId" } },
      ],
    },
  },
})
```

## Limitations

- **`define()` against this adapter throws.** It binds to the entities of the instance it was given;
  a definition naming an entity MikroORM has never heard of gets an error saying so. Add the entity
  to the MikroORM config, or define it against a different adapter.
- **Composite primary keys** are not supported. ormize reads
  `getPrimaryKeyNameForModel(...)[0]` throughout, so a two-column key would be half-used — an id
  minted from one column and a `node(id:)` lookup that never matches. Discovery raises instead,
  naming the entity.
- **MikroORM's auto-generated many-to-many pivot** is not registered as a model: it has a composite
  key and no identity beyond the pair it joins, and the relationship is walked through MikroORM's
  own `Collection`. A pivot you declare as an entity yourself *is* an ordinary model, which is what
  gives its extra columns somewhere to live.
- **Embeddables** surface as one `Object` field rather than a nested GraphQL type.
- **Polymorphic / single-table-inheritance** entities are discovered as their root only.

## Versions

Peer-compatible with MikroORM v6 and v7. The suites run against v7; the one API that moved between
them — the schema generator, `orm.getSchemaGenerator()` on v6 and `orm.schema` on v7 — is reached
through whichever is present, and nothing else in the adapter imports a value from
`@mikro-orm/core` at all.

MikroORM v7 is published as pure ESM. This repo's jest runs in CommonJS, so the package's
`jest.config.js` names `@mikro-orm` and `kysely` in `transformIgnorePatterns` to have them compiled
like any other source. Your own build is unaffected.

See the [guide](../../docs/guide.md) and the runnable
[`examples/mikro-orm-basic`](../../examples/mikro-orm-basic) demo.
