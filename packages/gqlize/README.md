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
- multi data source compatible, including cross adapter relationships e.g. `Sequelize[postgres]:Task:items[hasMany]->Sequelize[sqlite]:Item`
- Relay-compliant connections: `pageInfo: PageInfo!`, `edges: [XEdge!]!`, index-based cursors bound to the connection that minted them
- `@deprecated` on columns, relationships, exposed methods, mutation inputs, `orderBy` enum values and whole models
- The built schema is validated at build time, so an invalid `extend` / `root` / `override` type is an error where it was written rather than on every query at request time
- Pre-generated schema artifacts (`gqlize build` / `check` / `print`) with staleness fingerprinting

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

**Build this for artifact availability, reviewability and determinism — not for speed.** That is
measured, not hedged. Both processes cold, on one machine (Node 24.19, graphql 17.0.2, models of
8 fields each plus relay connections). `scripts/bench-artifact.ts` reproduces it —
`pnpm bench:artifact -- --models 1000 --topology wide --artifact /tmp/bench.json`:

| models | types | artifact | live `createSchema` | `JSON.parse` | `materializeSchema` | total load |
|---:|---:|---:|---:|---:|---:|---:|
| 150 | 3,913 | 3.05 MB | 93 ms | 16 ms | 113 ms | **129 ms** |
| 500 | 13,013 | 10.19 MB | 234 ms | 59 ms | 270 ms | **329 ms** |
| 1,000 | 26,013 | 20.39 MB | 436 ms | 94 ms | 580 ms | **674 ms** |

Loading an artifact is 1.4–1.6× the cost of building the schema live, and that gap is structural
rather than a missing optimisation: the output is a real `GraphQLSchema`, so both paths pay
graphql-js type construction, and the loader pays a `JSON.parse` and a staleness walk on top of it.
It does not remove the expensive step — it removes the *variable* one. What you get is a schema
that is a reviewable build output: diffable in a PR, checkable in CI, identical on every boot.

Neither number is usually the boot's problem. At 1,000 models the same process spends ~240 ms
loading modules and ~1.9 s in `initialise()`/`sync()`. If cold start is what you are actually
chasing, [`NODE_COMPILE_CACHE`](https://nodejs.org/api/module.html) (Node ≥ 22.8, or
`module.enableCompileCache()` from code) takes this repo's cold process from 459 ms to 318 ms
— 30% for one line, the same change that took
[`tsc --version` from ~122 ms to ~48 ms](https://github.com/microsoft/TypeScript/pull/59720).

The artifact is JSON, not SDL, and that is not a stylistic choice: `printSchema` discards enum
*internal* values, which is where `TaskOrderBy.nameASC`'s `["name","ASC"]` payload lives, and it
never prints applied directives. An SDL round-trip loses both, silently. SDL stays available as a
secondary artifact for codegen and CI diffs.

<details>
<summary><strong>Why there is no faster artifact format</strong> — two rejected designs, with the numbers</summary>

Both obvious ways to close the gap above have been built and measured, and neither works. The
reason is the same in both cases, so it is worth stating once: **the deliverable is a
`GraphQLSchema`** — a live JavaScript object graph of `GraphQLObjectType`s and their thunks — and
constructing it is the bill. The artifact format only decides how the *instructions* for that
construction arrive, and those were never the expensive part.

**A native (Rust/napi) artifact reader.** Profiling a cold 500-model load: `JSON.parse` is 62 ms and
a deep walk of every property in the parsed IR is 36 ms, out of a 332 ms load. A native reader that
made *both* free would land at ~234 ms against a 237 ms live build — parity, not a win, before
paying for a per-platform CI matrix and a JS fallback. This matches the published experience of the
boundary itself: [simdjson's Node binding](https://github.com/luizperes/simdjson_nodejs) loses to
`JSON.parse` on object-heavy documents because materialising the JS object graph eats the native
gain, and [oxc abandoned returning objects](https://github.com/oxc-project/oxc/issues/2409) for the
same reason.

**A compiled schema module** — emitting the artifact as JavaScript that constructs the schema
directly, the way Prisma generates a client, so V8 could cache the parse as bytecode. A complete
emitter was written and produces a `validateSchema`-clean schema identical to the JSON path
(`printSchema(lexicographicSortSchema(…))` equal across live, JSON and module). It is **2×
slower**, and gets worse with scale:

| 500 models / 13,013 types | JSON artifact | compiled module |
|---|---:|---:|
| `JSON.parse` / `import()` | 140 ms | 138 ms |
| build the types | 47 ms | 243 ms |
| `new GraphQLSchema` (forces the field thunks) | 317 ms | 644 ms |
| **total** | **505 ms** | **1,030 ms** |
| *at 1,000 models* | *823 ms* | *2,030 ms* |

The premise was that a bytecode cache would pay for the bigger parse. It does — and it does not
matter. `NODE_COMPILE_CACHE` halves the module's `import` (137 ms to 66 ms) and changes neither of
the other two rows, because it only covers what V8 compiled *eagerly*; the schema lives in function
bodies that V8 compiles lazily, on first call.

And first call is the only call. That is the whole result: the JSON path runs **one** `fieldMap`
function 13,000 times, which V8 optimises after the first few hundred, while the compiled module
runs **13,000 distinct one-shot functions**, each paying compilation and none of them ever hot.
Codegen trades hot shared code for cold unique code, which is the wrong trade when every line runs
exactly once. Note too that `import`ing 8 MB of JavaScript costs the same as `JSON.parse`-ing 10 MB
of JSON — so even emitting pure data literals instead of code saves nothing on the step it was
meant to remove.

If you want a faster boot, `checkStaleness: false` and `NODE_COMPILE_CACHE` are the two levers that
are actually on the table, and both are documented above.

</details>

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

### Saving it

`snapshotSchema(schema, opts?)` turns a built schema into a plain JSON-serializable object. Writing
it out is yours to do — which is the point: the same object goes to a file, an S3 bucket, or a
config service without the library taking a position on any of them.

```ts
import { writeFile } from "node:fs/promises";
import { createSchema } from "@azerothian/gqlize";
import { snapshotSchema } from "@azerothian/gqlize/snapshot";
import { buildOrm } from "./src/orm";
import { adminPermission } from "./src/permissions";
import { Money } from "./src/scalars";

async function build() {
  const orm = await buildOrm();                 // already initialise()d and sync()ed
  const schema = await createSchema(orm, { permission: adminPermission });

  const artifact = snapshotSchema(schema, {
    permissionProfile: "admin",                 // opaque id, checked at load
    scalars: { Money },                         // the same map the load must pass
  });

  await writeFile("./generated/schema.json", JSON.stringify(artifact));
}
```

The schema **must come from `createSchema`**. The builder attaches a ledger recording the
user-supplied types and the relay model map, neither of which is re-derivable from the type system
alone; a schema from anywhere else is rejected rather than silently snapshotted into something that
will not load.

| `SnapshotOptions` | |
| --- | --- |
| `scalars` | Custom scalars by name. Coercion is code, so these are named in the artifact and re-supplied at load — pass the same map to both ends. |
| `permissionProfile` | Opaque id folded into the fingerprint. `options.permission` is closures and cannot be hashed, so this is the handle on "which permission set built this". |
| `idProfile` / `cursorProfile` | The same, for `options.id` and `options.cursor` — codecs are closures too. Unlike `permissionProfile` these do not default to anything: two permission profiles legitimately share one ID format. |
| `orm` | The instance to fingerprint. Normally unnecessary — a schema from `createSchema` remembers the instance it was built from. Pass one when the schema came from elsewhere, or `false` to skip the fingerprint entirely (the artifact then loads with no staleness check, and says so). |

`snapshotSchema` is **fail loud**: anything it cannot describe throws at build time with the schema
coordinate, rather than dropping it and failing in production on request-shaped input. That covers
`isTypeOf` / `resolveType` (code), an enum internal value that is not JSON, a default value that
cannot be encoded as a literal, and — most usefully — a resolver with no binding descriptor, which
is how a hand-written resolver on a generated field gets caught.

Compress it by writing gzip; the loader detects that by magic bytes, not by extension, so an
artifact renamed by a deploy pipeline still loads:

```ts
import { gzipSync } from "node:zlib";
await writeFile("./generated/schema.json.gz", gzipSync(JSON.stringify(artifact)));
```

An SDL sidecar for codegen and CI diffs is just `printSchema` — a secondary artifact, never the
source of truth, for the reasons above:

```ts
import { printSchema } from "graphql";
await writeFile("./generated/schema.graphql", printSchema(schema));
```

If all of that is what you want, `buildArtifact` ([below](#programmatic-api)) is exactly this block
behind one call, and `gqlize build` is `buildArtifact` behind a CLI.

Both write **compact JSON**. Indentation nearly doubles the file — 20.4 MB to 40.7 MB on a
1,000-model schema — for an artifact that is machine-written and machine-read, and it costs about
11% on `JSON.parse` at load. `gqlize build --pretty`, or `pretty: true` in the config, gets the
indented form back for anyone diffing artifacts by eye; git's own diff does not need it.

### Loading it

```ts
import { loadSchema } from "@azerothian/gqlize/snapshot";

const orm = await buildOrm();
const schema = await loadSchema("./generated/schema.json", orm, {
  permission: adminPermission,       // the same options you pass to createSchema
  permissionProfile: "admin",
  scalars: { Money },
});
```

The ormize instance is not optional and is not a formality — it *is* the resolution engine. The
artifact replaces the type-system construction step only; every resolver in the loaded schema goes
back through the same `bindField` the live builder uses, against the live instance.

`loadSchema` reads `.json` or `.json.gz` from disk and hands off to `materializeSchema`. When the
artifact arrives some other way — a bundler import, object storage, a config service — call
`materializeSchema` directly with the parsed object:

```ts
import { materializeSchema } from "@azerothian/gqlize/snapshot";
import artifact from "./generated/schema.json";      // bundled at build time

const schema = await materializeSchema(artifact, orm, { permission });
```

```ts
const body = await s3.send(new GetObjectCommand({ Bucket, Key: "schema.json" }));
const schema = await materializeSchema(
  JSON.parse(await body.Body.transformToString()),
  orm,
  { permission, permissionProfile: "admin" },
);
```

`readSnapshot(path)` is the read-and-parse half on its own, for inspecting an artifact without
materializing it — a deploy gate that wants the fingerprint, or a script that counts types:

```ts
import { readSnapshot } from "@azerothian/gqlize/snapshot";

const artifact = await readSnapshot("./generated/schema.json");
console.log(artifact.formatVersion, artifact.types.length, artifact.fingerprint);
```

| Load option | |
| --- | --- |
| everything `createSchema` takes | `permission`, `subscriptions`, `extend`, `root`, … — passed exactly as at build |
| `scalars` | The same map `snapshotSchema` got. Omitting one throws naming the scalar, rather than failing at request time on coercion. |
| `permissionProfile` | Compared against the artifact's — see [Staleness](#staleness) |
| `idProfile` / `cursorProfile` | The same, for the ID and cursor codecs — see [Staleness](#staleness) |
| `onMismatch` | `"throw"` (default), `"warn"`, `"rebuild"` — see [Staleness](#staleness) |
| `checkStaleness` | `false` skips the fingerprint walk — a deliberate trade, see [Staleness](#staleness) |
| `extendFactory` | Late-bound `extend` / `root`, called once every type exists |

`options.extend` and `options.root` are **not** serialized — they are arbitrary user field configs
with arbitrary resolvers, so pass them at load exactly as you pass them to `createSchema`. Their
resolvers survive by reference, on the root field and on every field of every type nested inside it.
The ledger records which extend keys the build produced, so omitting one at load is an error naming
the missing `extend.<target>.<key>` rather than a schema quietly missing a field.

When an extend field needs to reference a *generated* type, use `extendFactory(types)` so it binds to
the materialized instance rather than a stale one. It may also return `root`, which is how a
subscription root built against generated types is supplied:

```ts
const schema = await loadSchema(artifact, orm, {
  extendFactory: (types) => ({
    query: { latest: { type: types.Task, resolve: () => ({}) } },
    root: { subscription: buildSubscription(types.Task) },
  }),
});
```

A type the artifact defines cannot also be supplied live: every type name must map to exactly one
instance, so passing a stale copy of a generated type through `extend` or `root` throws, naming the
type, where each instance came from, and pointing here. User-authored types are the other way
around — the artifact never contains one, so the instance you built is the instance the loaded
schema uses, coercion and nested resolvers intact.

Put together, an artifact-served server is the live one with `createSchema` swapped for `loadSchema`:

```ts
// src/server-artifact.ts
import { createServer } from "node:http";
import { join } from "node:path";
import { createYoga } from "graphql-yoga";
import { loadSchema } from "@azerothian/gqlize/snapshot";
import { buildOrm } from "./orm";

async function main() {
  const orm = await buildOrm();
  const artifact = join(__dirname, "..", "generated", "schema.json");
  const schema = await loadSchema(artifact, orm, {
    permission: adminPermission,
    permissionProfile: "admin",
    scalars: { Money },
    onMismatch: process.env.NODE_ENV === "production" ? "throw" : "rebuild",
  });

  const yoga = createYoga({ schema, context: () => ({ instance: orm }) });
  createServer(yoga).listen(4000);
}

main();
```

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
of closures and closures cannot be hashed. Nothing about `options.permission` is fingerprinted for
that reason — the load-time options object is built by the server, often per request, and differing
from the build's says nothing about the artifact. Two mitigations: pass an opaque `permissionProfile` id
(recorded in the fingerprint, so an `admin` artifact loaded under `anon` is caught), and run
`gqlize check` in CI — by default it does not stop at the fingerprint, it builds the schema live,
materializes the artifact, and diffs the sorted SDL. That catches *any* divergence, permissions
included. `--no-strict` drops to the fingerprint-only comparison.

`permissionProfile` is compared only when the load names one: staying silent about it is not a
claim that it changed, so the artifact's value is carried forward and a warning notes that
permission drift went unchecked. Naming a different profile still throws. `idProfile` and
`cursorProfile` behave identically.

`options.id` and `options.cursor` are closures for the same reason and are not hashed either, but
their failure is sharper than a permission mismatch: an artifact built with codecs and served
without them resolves perfectly well, in the wrong format — clients get relay IDs where the schema
expects prefixed ones. So the fingerprint does record *whether* each was configured (and whether
the ID codec carries a type), which catches that case without any profile being named; the profiles
are what catch one codec swapped for another of the same shape.

The fingerprint is deliberately dialect-invariant: building against SQLite in CI and serving
Postgres in production is a normal setup, and the dialect does not affect schema shape.

Computing it means walking every definition back through the adapter, which is not free: about 6 ms
at 150 models and **79 ms at 1,000** — 13–21% of the load. `checkStaleness: false` skips the walk
entirely rather than computing it and ignoring the result:

```ts
const schema = await loadSchema(artifact, orm, {
  permission,
  checkStaleness: false,        // CI already ran `gqlize check --strict` on this commit
});
```

Take that trade only when something else guarantees the pair. `gqlize check --strict` in the same
pipeline that produced the artifact is that something — it is a stronger check than the fingerprint
anyway, since it diffs the whole SDL. Without it you are asserting freshness on trust, and a stale
artifact loaded unchecked serves the wrong schema without complaint. It is never silent, for the
same reason a missing fingerprint is not: the loader warns once on the way past.

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

### When it refuses

Every one of these is deliberate: the artifact is a build output, and a build output that half-works
is worse than one that stops. What each means:

| Message | What happened |
| --- | --- |
| `schema has no build ledger` | `snapshotSchema` was handed a schema that did not come from `createSchema`. |
| `<coordinate> has a resolver but no binding descriptor` | A resolver was attached to a generated field outside the builder — it is code, so it cannot be serialized. Move it to `extend`, or to the definition's `override` / `expose`. |
| `<Type> defines isTypeOf` / `resolveType, which is code` | Same reason, at the type level. |
| `enum value X.Y carries a non-JSON internal value` | An enum's internal value is a class instance, function, `undefined`, … Only JSON-representable values round-trip. |
| `scalar "X" is not in the scalar registry` | A custom scalar was in the schema at build, or named by the artifact at load, without being in `scalars`. Pass the same map to both ends. |
| `snapshot formatVersion N is not supported` | The artifact predates the running gqlize. Rebuild it. |
| `the schema artifact is stale — <part> differs` | The definitions moved under the artifact. Rebuild it, or see [Staleness](#staleness) for `onMismatch`. |
| `the artifact was built with extend.query.X, which the load-time options do not supply` | The build had an extend field the load does not. Pass it, via `extend` or `extendFactory`. |
| `the schema contains more than one type per name` | A live type collided with one the artifact defines. The message names each instance's path and origin; if the live one is a generated type from another build, supply it through `extendFactory` so it binds to this schema's instance. |
| `artifact carries no fingerprint` (warning) | Built with `orm: false`. It loads, unchecked. |

## Adapters

- Sequelize - https://github.com/VostroNet/gqlize-adapter-sequelize

## TODO

Functional
- validate submitted definitions via JSON Schema v7
- reimplement subscriptions (see [gqlize#54](https://github.com/Azerothian/gqlize/issues/54) — the
  artifact half is missing too: reachability seeds only the query and mutation roots)
- schema directives: nothing in the IR carries them, so a directive on a user-authored `extend` /
  `root` type is dropped by `snapshotSchema`
- user-declared interfaces and unions (only the Relay `Node` interface is generated today)
- `@oneOf` input objects
- add middleware options to allow for caching of items?
- cross adapter **writes**, and batching of cross adapter reads by foreign key

Adapters
- add elasticsearch adapter
- add http graphql relay adapter

Deliberately out of scope
- `@defer` / `@stream` and query cost/depth limiting — execution- and validation-layer concerns
  owned by the host server. One caveat: a `@stream`ed field still goes through
  `build-include-from-selection.ts`, which builds its eager-load tree from the whole selection set,
  so streaming would over-fetch rather than break.
- Federation.
- DataLoader-style batching for same-adapter reads — the selection-set-driven `include` builder
  already collapses the N+1 in SQL.

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
