# @azerothian/ormize

The GraphQL-free backend of [gqlize](../gqlize): a relational data-binder / ORM manager for
multiple data sources. `ormize` owns model definitions, adapter registration, typed model access,
lifecycle hooks, relationship wiring, and `sync` — with **no `graphql` dependency**. Add
[`@azerothian/gqlize`](../gqlize) on top when you want a GraphQL schema.

## Install

```bash
pnpm add @azerothian/ormize @azerothian/ormize-adapter-sequelize sequelize
# plus a Sequelize driver, e.g. sqlite3 / pg
```

## Usage

```ts
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

const orm = new Ormize()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef);         // or orm.addDefinition(taskDefinition)

await orm.initialise();
await orm.sync();

// CRUD via the underlying ORM models (typed when you use defineModel):
await orm.models.Task.create({ name: "alpha" });
const rows = await orm.models.Task.findAll();
```

## What lives here vs gqlize

- **ormize** (this package): `Ormize` manager — `registerAdapter`, `define`/`addDefinition`,
  `models`, hooks (`addHook`/`createHook`/`runHook`), `getAssociations`, `getFields`,
  `getGlobalKeys`, `initialise`/`sync`/`reset`, relationship wiring, and the definition typesystem
  (`ITypedDefinition`, `IORModel`, …). No GraphQL.
- **gqlize**: `createSchema(orm, options)` builds a `graphql` schema from an `ormize` instance —
  query/mutation resolution, relay global IDs, connections, filter/order types.

## Typed models

The definition typesystem is shared with the adapter. Declare a Sequelize instance interface and
pass it to `defineModel` (from the adapter), then `orm.define(...)` for a typed `orm.models.<Name>`.
See the [adapter README → Typed models](../ormize-adapter-sequelize/README.md#typed-models).

## License

MIT
