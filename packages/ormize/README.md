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

## Transactions & context

Each mutation is already atomic on its own adapter. To make several operations one unit of work —
including across adapters — wrap them in `orm.transaction(fn)`: it commits every adapter it touches
on success and **rolls them all back if `fn` throws** (best-effort coordination, not two-phase
commit). Nested calls join the active transaction.

```ts
await orm.transaction(async () => {
  await orm.processCreate("Order",   null, { input: { /* … */ } }, {}, undefined); // adapter A
  await orm.processCreate("Payment", null, { input: { /* … */ } }, {}, undefined); // adapter B → fails → both roll back
});
```

`orm.runWithContext(context, fn)` makes `context` ambient (via `AsyncLocalStorage`) so
`orm.getContext()` — and `definition.before`/`after` hooks — can read it without threading. See the
runnable [`cross-adapter-transaction` example](../../examples/cross-adapter-transaction).

## Typed models

The definition typesystem is shared with the adapter. Declare a Sequelize instance interface and
pass it to `defineModel` (from the adapter), then `orm.define(...)` for a typed `orm.models.<Name>`.
See the [adapter README → Typed models](../ormize-adapter-sequelize/README.md#typed-models).

## License

MIT
