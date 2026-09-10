# @azerothian/ormize-adapter-sequelize

Sequelize adapter for [`@azerothian/ormize`](../ormize) — pairs with the `Ormize` backend
manager to connect Sequelize 6 data sources. When used together with
[`@azerothian/gqlize`](../gqlize), enables full GraphQL schema generation over Sequelize models.

## Install

```sh
pnpm add @azerothian/ormize @azerothian/gqlize @azerothian/ormize-adapter-sequelize
```

Provide the peer dependencies in your project:

```sh
pnpm add graphql@^17.0.0 graphql-relay@^0.10.0 sequelize@^6.35.1
```

(`@azerothian/graphql-types` is pulled in automatically. See the [gqlize README](../gqlize/README.md#caveats) for the required `graphql` mutation patch.)

## Typed models

Definitions are normally untyped (`db.models.<Name>` is `any`). This adapter ships an
opt-in typesystem so `db.models.<Name>` is a fully-typed Sequelize model — instance
attributes from the definition and static methods from `classMethods`.

You declare the model **instance** interface the standard [Sequelize v6 way](https://sequelize.org/docs/v6/other-topics/typescript/)
(`Model<InferAttributes<M>, InferCreationAttributes<M>>`), pass it (plus a statics type) to
`defineModel`, and register with the fluent `db.define(...)`:

```ts
import Sequelize, {
  Model, InferAttributes, InferCreationAttributes, CreationOptional,
} from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter, { defineModel } from "@azerothian/ormize-adapter-sequelize";

interface TaskInstance
  extends Model<InferAttributes<TaskInstance>, InferCreationAttributes<TaskInstance>> {
  id: CreationOptional<number>;    // optional on create
  name: string;
  qty: number | null;             // nullable
}
interface TaskStatics {
  countAll(args: any, context: any): Promise<number>;
}

const TaskDef = defineModel<TaskInstance, TaskStatics>({
  name: "Task",
  define: {
    name: { type: Sequelize.STRING, allowNull: false },
    qty: { type: Sequelize.INTEGER, allowNull: true },
  },
  classMethods: {
    async countAll(this: any) { return this.count(); },
  },
});

const db = new Ormize()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef);

await db.initialise();   // models are created here (define() is deferred + chainable)
await db.sync();

const task = await db.models.Task.create({ name: "alpha", qty: 3 }); // fully typed
task.name;                                   // string
await db.models.Task.countAll(undefined, {}); // Promise<number>
// db.models.Task.create({})                 // ❌ compile error — `name` is required
```

Notes:
- `defineModel` is a **runtime identity** — the type parameters are erased; it only adds types.
- Instance methods are declared as function members of the instance interface (Sequelize's
  `InferAttributes` excludes them); associations use `NonAttribute<…>`.
- The untyped async `db.addDefinition(def)` still works unchanged — the typesystem is opt-in.
- The optionality guarantees (e.g. required `create` attributes) hold under `strictNullChecks`.

### Composing fragments — required / optional buckets

`SequelizeModel<Required, Optional>` (alias for `IORModel<IORSequelizeModel, Required, Optional>`)
composes several definition fragments into one model type. Required fragments contribute
**required** members; optional fragments contribute **optional** (`?`) members:

```ts
import { defineModel, SequelizeModel } from "@azerothian/ormize-adapter-sequelize";

const TaskV1 = defineModel<TaskV1Instance, { staticMethod1(a: string, c: any): Promise<any> }>({ /* … */ });
const TaskV2 = defineModel<TaskV2Instance, { staticMethod2(a: string, c: any): string }>({ /* … */ });

type TaskModel = SequelizeModel<[typeof TaskV1], [typeof TaskV2]>;
// instance: { name: string; author?: string }
// statics:  staticMethod1: (…) => Promise<any>;  staticMethod2?: (…) => string
```

## Raw DDL (`definition.queries`)

A Sequelize-only definition key, for the schema objects `sequelize.define` cannot create —
a Postgres `CREATE TYPE`, an extension, a trigger:

```ts
const TaskDef = {
  name: "Task",
  define: { /* … */ },
  queries: {
    genre: {
      create: "CREATE TYPE genre AS ENUM ('fiction', 'history');",
      drop: "DROP TYPE IF EXISTS genre;",
    },
  },
};
```

Each entry's `create` (a string, or a thunk returning one) is replayed by `initialise()`, and
`reset()` replays the `drop`s and then the `create`s.

This is the adapter's **only** I/O during `initialise()` — `sequelize.define` and the association
calls are pure metadata. That is what `initialise({ ddl: false })` turns off:

```ts
await db.initialise({ ddl: false });   // wire the models up, issue no DDL
```

Which matters because generating a GraphQL schema reads model metadata and never queries, so with
this flag `@azerothian/gqlize` can build a schema — or a whole pre-generated artifact — with no
database anywhere. An instance initialised this way cannot serve a request: the DDL it skipped is
DDL the database still needs. See
[gqlize: building without a database](../gqlize/README.md#building-without-a-database).

## License

This repository generally is covered by MIT unless specified


## TODO
- Setup Documentation
- change where/filter object for sequelize adapter to typed object 
- implement includes
- test if model has a defaultValue is a 0 value, it sets the field as autoPopulated
- Write more unit tests

## Contributers

- Mick Hansen (Not a direct contributor, but I used alot of his code from graphql-sequelize as a reference and blatantly copied some)
- Lousie Apostol
- Matthew Mckenzie
