# gqlize

A relational databinder for generating graphql schemas to connect and work with multi data sources, used to be called [sql2gql](https://github.com/VostroNet/sql2gql/tree/v3)

## Install

```sh
pnpm add @azerothian/gqlize @azerothian/gqlize-adapter-sequelize
```

`gqlize` and the Sequelize adapter expect these peer dependencies in your project:

```sh
pnpm add graphql@^17.0.0 graphql-relay@^0.10.0 sequelize@^6.35.1
```

(`@azerothian/gqlize-shared` and `@azerothian/graphql-types` are pulled in automatically.)

> gqlize needs a small patch to `graphql` so nested mutation fields execute serially — see
> [Caveats](#caveats) below.

## License

MIT

## Features

- Relational GraphQL Schema generator
- Supports Query and Mutations
- Fine grained permission control on which fields, models that you can query, mutate (Create, Update, Delete) directly via graphql
- multi data source compatible,
- Planned: cross adapter relationships e.g. `Sequelize[postgres]:Task:items[hasMany]->Sequelize[sqlite]:Item`

## Caveats

### Problem

Until [Proposal #252](https://github.com/graphql/graphql-spec/issues/252) is introduced, the schema generated is incompatible for mutations as subfields get executed asyncronously, only top level items get executed syncronously.

### Solution

`graphql` executes a mutation's **top-level** fields serially, but nested sub-fields run
asynchronously. gqlize needs nested mutation sub-fields to run serially too. This is a small,
non-breaking change to `executeCollectedSubfields` in graphql's `execution` module (route nested
mutation fields through `executeFieldsSerially`).

`graphql` is a **peer dependency** (`^17.0.0`); gqlize does not bundle a graphql fork. This monorepo
applies the change as a committed [pnpm patch](https://pnpm.io/cli/patch),
`patches/graphql@17.0.2.patch`, wired up in the root `package.json`:

```jsonc
"pnpm": {
  "overrides": { "graphql": "17.0.2" },
  "patchedDependencies": { "graphql@17.0.2": "patches/graphql@17.0.2.patch" }
}
```

Downstream consumers who need serial nested mutations can reuse the same patch file (pnpm patches
do not travel with a published package). graphql still insists on a single copy in `node_modules`;
the `overrides` entry pins the whole tree to one patched `graphql@17.0.2`.

## Typed models (opt-in)

By default `db.models.<Name>` is `any`. gqlize also offers a fluent, typed registration so
models are strongly typed — instance attributes from the definition and static methods from
`classMethods`:

```ts
const db = new Database()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef)     // TaskDef built with the adapter's `defineModel<TInstance, TStatics>()`
  .define(ItemDef);
await db.initialise();
await db.sync();

db.models.Task.create({ name: "x" });   // fully typed (create args, return instance)
```

`define()` is synchronous and chainable; models are created during `initialise()`. The core is
adapter-agnostic — the model type is provided by the adapter (see
[`@azerothian/gqlize-adapter-sequelize` → Typed models](../gqlize-adapter-sequelize/README.md#typed-models),
which is where `defineModel` / `SequelizeModel` live). The untyped `db.addDefinition(def)` still
works unchanged.

## Adapters

- Sequelize - https://github.com/VostroNet/gqlize-adapter-sequelize

## TODO

- Use TravisCI for deployments

Documentation
- Install/Setup
- Model Definitions
- Adapter API
- Example Project
- Everything 

Functional
- validate submitted definitions via JSON Schema v7
- reimplement subscriptions
- before, after event hooks
- Implement cross adapter relationships
- add middleware options to allow for caching of items?

Unit Tests
- test add/remove from relationships
- test where operators
- test multiple enums
- test paging
- More Unit tests

Adapters
- add elasticsearch adapter
- add http graphql relay adapter

## Contributers

- Mick Hansen (Not a direct contributor, but I used alot of his code from graphql-sequelize as a reference and blatantly copied some)
- Lousie Apostol
- Matthew Mckenzie

## Example Query

```
query {
  models { 
    Task { 
      edges { 
        node { 
          id, 
          name, 
          items { 
            edges { 
              node { 
                id 
              } 
            } 
          } 
        } 
      } 
    } 
  }
}
```

## Example Mutation
```
mutation {
  models {
    Task(update: {
      where: {
        name: "start" 
      },
      input: {
        items: {
          remove: {
            name: {
              in: ["item000002", "item000003"]
            }
          }
        }
      }
    }) {
      id
      items {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
}
```
