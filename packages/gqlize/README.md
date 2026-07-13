# gqlize

A relational databinder for generating graphql schemas to connect and work with multi data sources, used to be called [sql2gql](https://github.com/VostroNet/sql2gql/tree/v3)

## Install

```
yarn add @vostro/gqlize @vostro/gqlize-adapter-sequelize @vostro/graphql-types graphql-sequelize
```

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
non-breaking change to `completeObjectValue` in graphql's `execution/execute` module (route nested
mutation fields through `executeFieldsSerially`).

`graphql` is a **peer dependency** (`^16.8.1`); gqlize does not bundle a graphql fork. This monorepo
applies the change as a committed [pnpm patch](https://pnpm.io/cli/patch),
`patches/graphql@16.8.1.patch`, wired up in the root `package.json`:

```jsonc
"pnpm": {
  "overrides": { "graphql": "16.8.1" },
  "patchedDependencies": { "graphql@16.8.1": "patches/graphql@16.8.1.patch" }
}
```

Downstream consumers who need serial nested mutations can reuse the same patch file (pnpm patches
do not travel with a published package). graphql still insists on a single copy in `node_modules`;
the `overrides` entry pins the whole tree to one patched `graphql@16.8.1`.

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
