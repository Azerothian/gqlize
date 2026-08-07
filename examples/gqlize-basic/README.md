# gqlize basic example

A minimal, **runnable** GraphQL API built from an [`@azerothian/ormize`](../../packages/ormize)
instance with [`@azerothian/gqlize`](../../packages/gqlize). It defines two models
(`Item` has many `Task`), projects them to a Relay GraphQL schema with `createSchema(orm)`, and serves
it over [graphql-yoga](https://the-guild.dev/graphql/yoga-server) with an in-memory SQLite database.

The same `Item`/`Task` definitions are used by the [nestize REST example](../nestize-rest) — the two
packages are different projections of one ormize instance.

## Run it

From the **repo root** (installs the whole workspace once):

```sh
pnpm install
```

Then start the server:

```sh
pnpm --filter @azerothian/example-gqlize-basic start
# gqlize example listening on http://localhost:4000/graphql
```

Open <http://localhost:4000/graphql> in a browser for the **GraphiQL** explorer, or run the operations
in-process without a server:

```sh
pnpm --filter @azerothian/example-gqlize-basic query
```

Set `PORT` to change the port (`PORT=4001 pnpm --filter @azerothian/example-gqlize-basic start`).

## How it wires together

| File | Responsibility |
| --- | --- |
| [`src/models.ts`](src/models.ts) | Two ormize `Definition`s (`Item`, `Task`) using Sequelize `DataType`s + a relationship. |
| [`src/orm.ts`](src/orm.ts) | `new Ormize()` → `registerAdapter(new SequelizeAdapter(...))` → `addDefinition()` → `initialise()` → `sync()`, then seeds rows. |
| [`src/server.ts`](src/server.ts) | `const schema = await createSchema(orm)` → serve with graphql-yoga. |
| [`src/run.ts`](src/run.ts) | Executes a query + mutation in-process via `graphql()` (no HTTP). |
| [`gqlize.config.ts`](gqlize.config.ts) | Config for the `gqlize` CLI — where the orm comes from and where the artifact goes. |
| [`src/server-artifact.ts`](src/server-artifact.ts) | The same server, served off a pre-generated schema artifact. |

The whole projection is one call:

```ts
import { createSchema } from "@azerothian/gqlize";
const schema = await createSchema(orm); // -> graphql-js GraphQLSchema
```

## Sample operations

**List** (Relay connection; `id` is a global id):

```graphql
query {
  models {
    Task {
      edges { node { id name done } }
    }
  }
}
```
```json
{ "data": { "models": { "Task": { "edges": [
  { "node": { "id": "VGFzazox", "name": "Buy milk", "done": false } },
  { "node": { "id": "VGFzazoy", "name": "Buy eggs", "done": true } }
] } } } }
```

**Traverse a relationship** (`Task` → its `Item` → back to that item's `tasks`):

```graphql
query {
  models {
    Task {
      edges { node { id name item { label tasks { edges { node { name } } } } } }
    }
  }
}
```

**Create** (mutations live under `models.<Model>(create: …)` and return the affected rows):

```graphql
mutation {
  models {
    Task(create: { name: "Buy bread" }) { id name done }
  }
}
```

**Look up any node by global id** (Relay `node`):

```graphql
query ($id: ID!) {
  node(id: $id) {
    id
    __typename
    ... on Task { name }
  }
}
```

## Permissions

`createSchema` accepts a `permission` predicate bag (structural, build-time gating — models, fields,
relationships, mutations). Either write the predicates inline, or use the role helper:

```ts
import { createRoleBasedPermissions } from "@azerothian/ormize";

const permission = createRoleBasedPermissions(
  "user",
  { user: { query: "allow", model: { Task: "allow" }, field: { Task: { name: "allow" } } } },
  { defaultDeny: false },
);
const schema = await createSchema(orm, { permission });
```

See the [`@azerothian/gqlize` README](../../packages/gqlize/README.md) for the full feature set
(typed models, hooks, custom `where` operators, class/instance methods).

## Pre-generated schema artifact

Instead of building the schema on every boot, generate it once and load it:

```sh
pnpm --filter @azerothian/example-gqlize-basic schema:build   # -> generated/schema.json + .graphql
pnpm --filter @azerothian/example-gqlize-basic schema:check   # exit 1 if it no longer matches the models
pnpm --filter @azerothian/example-gqlize-basic start:artifact # the same server, served off the artifact
```

[`src/server-artifact.ts`](src/server-artifact.ts) is the whole difference:

```ts
const schema = await loadSchema("./generated/schema.json", orm, { onMismatch: "rebuild" });
```

The ormize instance is still required — it is the resolution engine the schema binds to; the
artifact only replaces the *type construction* step. `schema:check` is the CI gate: it builds the
schema live, materializes the artifact, and diffs the sorted SDL, so any drift fails the build.

> The `schema:*` scripts run the CLI from source (`node -r @swc-node/register
> ../../packages/gqlize/src/cli/index.ts`) because this example uses the workspace packages
> unbuilt. In your own project, `@azerothian/gqlize` installs a `gqlize` binary, so these are just
> `gqlize build` / `gqlize check`.

## Notes

- Runs the workspace packages **from source** via `@swc-node/register` (swc, so no build step is
  needed) and the `paths` in [`tsconfig.json`](tsconfig.json). In your own project you would instead
  `npm install @azerothian/gqlize @azerothian/ormize @azerothian/ormize-adapter-sequelize graphql graphql-relay sequelize`
  and import normally.
- `graphql` is pinned to `17.0.2` across this monorepo (see the root README's *GraphQL* section).
