# @azerothian/gqlize

The GraphQL layer of the gqlize / ormize project. Takes an `@azerothian/ormize` instance and
generates a complete Relay-style GraphQL schema — object types, connections, queries, deep nested
mutations, and fine-grained permissions — so you don't hand-write resolvers or SDL.

Previously part of `@azerothian/gqlize` (which also contained the backend manager). The backend
manager is now in [`@azerothian/ormize`](../ormize). Used to be called
[sql2gql](https://github.com/VostroNet/sql2gql/tree/v3).

## Install

```sh
pnpm add @azerothian/ormize @azerothian/gqlize @azerothian/ormize-adapter-sequelize
```

`gqlize` and the Sequelize adapter expect these peer dependencies in your project:

```sh
pnpm add graphql@^17.0.0 graphql-relay@^0.10.0 sequelize@^6.35.1
```

(`@azerothian/utilize` and `@azerothian/graphql-types` are pulled in automatically.)

> gqlize needs a small patch to `graphql` so nested mutation fields execute serially — see
> [Caveats](#caveats) below.

## Example project

[`examples/gqlize-basic`](../../examples/gqlize-basic) is a complete, runnable GraphQL server
(models → ormize → `createSchema` → graphql-yoga + GraphiQL). Start it from the repo root with
`pnpm --filter @azerothian/example-gqlize-basic start`.

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

By default `db.models.<Name>` is `any`. The fluent typed registration from `@azerothian/ormize`
makes models strongly typed — instance attributes from the definition and static methods from
`classMethods`:

```ts
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

const db = new Ormize()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef)     // TaskDef built with the adapter's `defineModel<TInstance, TStatics>()`
  .define(ItemDef);
await db.initialise();
await db.sync();

db.models.Task.create({ name: "x" });   // fully typed (create args, return instance)
```

`define()` is synchronous and chainable; models are created during `initialise()`. The core is
adapter-agnostic — the model type is provided by the adapter (see
[`@azerothian/ormize-adapter-sequelize` → Typed models](../ormize-adapter-sequelize/README.md#typed-models),
which is where `defineModel` / `SequelizeModel` live). The untyped `db.addDefinition(def)` still
works unchanged.

## Pre-generated schema artifacts

`createSchema(orm, options)` builds the schema from scratch on every boot. You can instead
pre-generate it into a JSON artifact, review and diff it like any other build output, and rebuild an
executable schema from it at boot:

```sh
npx gqlize build      # ./gqlize.schema.json  (+ an optional SDL sidecar)
npx gqlize check      # exit 1 if the artifact no longer matches the definitions
npx gqlize print      # the schema as SDL, live or --from-artifact
```

**Build this for artifact availability, reviewability and determinism, not for speed.** The
generator is a small part of a boot dominated by loading the driver and `initialise()`/`sync()`, and
the loader still needs the ormize instance — it *is* the resolution engine. Measure before claiming
a startup win.

The artifact is JSON, not SDL, and that is not a stylistic choice: `printSchema` discards enum
*internal* values, which is where `TaskOrderBy.nameASC`'s `["name","ASC"]` payload lives, and it
never prints applied directives. An SDL round-trip loses both, silently. SDL stays available as a
secondary artifact for codegen and CI diffs.

### Config

```ts
// gqlize.config.ts
import { defineConfig } from "@azerothian/gqlize/cli/types";
import { buildOrm } from "./src/orm";
import { adminPermission, anonPermission } from "./src/permissions";

export default defineConfig({
  orm: () => buildOrm(),               // already initialise()d and sync()ed
  out: "./generated/schema.json",
  sdl: "./generated/schema.graphql",   // optional; for codegen / CI diffs
  profiles: {
    admin: { options: { permission: adminPermission } },
    anon:  { options: { permission: anonPermission  } },
  },
});
```

`gqlize build --all-profiles` writes one artifact per profile, folding the profile name into the
filename (`schema.admin.json`, `schema.anon.json`) so two profiles can never collide on one file.

Discovery order is `--config`, then the nearest `gqlize.config.{ts,mts,mjs,js,cjs}` walking up from
the cwd, then a `"gqlize": "./path/to/config"` pointer in `package.json`.

### Loading it

```ts
import { loadSchema } from "@azerothian/gqlize/snapshot";

const orm = await buildOrm();
const schema = await loadSchema("./generated/schema.json", orm, {
  permission: adminPermission,       // the same options you pass to createSchema
  permissionProfile: "admin",
});
```

`loadSchema` reads `.json` or `.json.gz` (detected by content, not extension) and hands off to
`materializeSchema(snapshot, orm, options)`, which is what to call when the artifact arrives from a
bundler import, S3, or a config service instead of the filesystem.

`options.extend` and `options.root` are **not** serialized — they are arbitrary user field configs
with arbitrary resolvers, so pass them at load exactly as you pass them to `createSchema`. When an
extend field needs to reference a *generated* type, use `extendFactory(types)` so it binds to the
materialized instance rather than a stale one.

### Staleness

Every artifact carries a fingerprint of the definitions it was built from — models, fields,
relationships, class methods, adapters, the gqlize and graphql versions. A mismatch throws at load:

```
gqlize: the schema artifact is stale — models differs from the live definitions. Rebuild it.
```

`onMismatch` controls that: `"throw"` (default), `"warn"` (load it anyway), or `"rebuild"` (fall
back to a live `createSchema`) — the last being a good development default so a model edit does not
force a rebuild step mid-iteration:

```ts
const schema = await loadSchema(artifact, orm, {
  permission,
  onMismatch: process.env.NODE_ENV === "production" ? "throw" : "rebuild",
});
```

**The one drift the fingerprint cannot see is permissions**, because `options.permission` is a bag
of closures and closures cannot be hashed. Two mitigations: pass an opaque `permissionProfile` id
(recorded in the fingerprint, so an `admin` artifact loaded under `anon` is caught), and run
`gqlize check` in CI — by default it does not stop at the fingerprint, it builds the schema live,
materializes the artifact, and diffs the sorted SDL. That catches *any* divergence, permissions
included. `--no-strict` drops to the fingerprint-only comparison.

The fingerprint is deliberately dialect-invariant: building against SQLite in CI and serving
Postgres in production is a normal setup, and the dialect does not affect schema shape.

### Programmatic API

Everything the CLI does is a public function on `@azerothian/gqlize/snapshot`:

```ts
snapshotSchema(schema, opts?)                 // GraphQLSchema  -> SchemaSnapshot
materializeSchema(snapshot, orm, options?)    // SchemaSnapshot -> GraphQLSchema
loadSchema(path, orm, options?)               // read + parse + materialize
readSnapshot(path)                            // read + parse only (.json / .json.gz)
buildArtifact(orm, opts)                      // build + snapshot + write to disk
fingerprintDefinitions(orm, opts?)            // Ormize -> Fingerprint
compareFingerprints(a, b)                     // -> the names of the differing parts
```

`buildArtifact` is exactly what `gqlize build` calls per profile — build the schema, snapshot it,
and write it to disk (gzipped if `out` ends in `.gz`, plus an SDL sidecar if `sdl` is given). Reach
for it when you want an artifact from your own build script or task runner instead of shelling out
to the CLI:

```ts
import { buildArtifact } from "@azerothian/gqlize/snapshot";

const orm = await buildOrm(); // already initialise()d and sync()ed
const { out, typeCount, fieldCount } = await buildArtifact(orm, {
  out: "./generated/schema.json",
  sdl: "./generated/schema.graphql",
  permissionProfile: "admin",
  options: { permission: adminPermission },
});
console.log(`wrote ${out}: ${typeCount} types, ${fieldCount} fields`);
```

so a health probe or a bespoke CI gate needs no CLI at all:

```ts
const drift = compareFingerprints(
  artifact.fingerprint,
  fingerprintDefinitions(orm, { permissionProfile: "admin" }),
);
if (drift.length) throw new Error(`stale gqlize artifact: ${drift.join(", ")}`);
```

Custom scalars are code, so they cannot be serialized. Pass the same map to both ends — omitting one
at load throws with the scalar's name rather than failing at request time:

```ts
const artifact = snapshotSchema(schema, { scalars: { Money } });
const schema   = await materializeSchema(artifact, orm, { permission, scalars: { Money } });
```

[`examples/gqlize-basic`](../../examples/gqlize-basic) has a working config and an artifact-served
server (`pnpm schema:build && pnpm start:artifact`).

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

Relationship mutations support `create`, `update`, `delete`, `add`, `set`, `remove`, `restore`, and
`select`. **`select`** finds existing records by filter and runs further relationship mutations on
them **without modifying the found records themselves** — it's available top-level (a sibling of
`create`/`update`/`delete`) and nested on any relationship. Nested `select` is relationship-scoped:

```
mutation {
  models {
    # find "start", then (among ITS items) find "item1" and add a sub-tag — without changing either
    Task(select: [{
      where: { name: { eq: "start" } },
      input: { items: { select: [{ where: { name: { eq: "item1" } }, input: { tags: { add: [{ where: { name: { eq: "urgent" } } }] } } }] } }
    }]) { id }
  }
}
```

See the [usage guide](../../docs/guide.md) for the full mutation reference, and the
[typed-models section](#typed-models-opt-in) for compile-time model typing.
