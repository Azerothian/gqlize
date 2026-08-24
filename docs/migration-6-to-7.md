# Migrating from 6.x to 7.x

7.0 is a re-architecture, not a feature release. The single `@azerothian/gqlize` package has been
split into a layered set of packages, GraphQL has moved from 16 to 17, and several defaults changed
in ways that **will reject queries and silently drop mutation inputs that worked in 6.x**.

Read [§3 Behavioural changes](#3-behavioural-changes) even if the mechanical rename in §2 goes
cleanly — that section is where working code breaks.

## Contents

1. [The package split](#1-the-package-split)
2. [Mechanical migration](#2-mechanical-migration)
3. [Behavioural changes](#3-behavioural-changes)
   - [Mass assignment: primary keys and foreign keys are no longer writable](#mass-assignment-primary-keys-and-foreign-keys-are-no-longer-writable)
   - [Pagination is bounded: 100 by default, 1000 maximum](#pagination-is-bounded-100-by-default-1000-maximum)
   - [Regex `where` operators are opt-in](#regex-where-operators-are-opt-in)
   - [Filter, order and include input types are permission-gated](#filter-order-and-include-input-types-are-permission-gated)
   - [`node(id)` goes through the authorized path](#nodeid-goes-through-the-authorized-path)
   - [Relay `pageInfo` is derived from the window's absolute position](#relay-pageinfo-is-derived-from-the-windows-absolute-position)
   - [Mutations run in a transaction](#mutations-run-in-a-transaction)
   - [`createListObject` takes a data-source descriptor, not a resolver](#createlistobject-takes-a-data-source-descriptor-not-a-resolver)
   - [Role-based permissions now gate `extend` fields and mutation inputs](#role-based-permissions-now-gate-extend-fields-and-mutation-inputs)
   - [Unknown `permission` keys are a type error, and warn at build time](#unknown-permission-keys-are-a-type-error-and-warn-at-build-time)
4. [The graphql patch](#4-the-graphql-patch)
5. [New in 7.x](#5-new-in-7x)
6. [Checklist](#6-checklist)

---

## 1. The package split

6.x shipped two packages: `@azerothian/gqlize` (the manager *and* the GraphQL schema generator, in
one) and `@azerothian/gqlize-adapter-sequelize`.

7.x splits the manager away from GraphQL, so the same data layer can be projected into GraphQL, Zod
or REST:

```
graphql-types + utilize
        ↓
      ormize                      ← the data layer; no GraphQL dependency
     ↙   ↓   ↘
gqlize  ormize-zod4  nestize      ← three projections of one Ormize instance
```

| 6.x | 7.x |
| --- | --- |
| `@azerothian/gqlize` (manager) | [`@azerothian/ormize`](../packages/ormize) |
| `@azerothian/gqlize` (schema) | [`@azerothian/gqlize`](../packages/gqlize) |
| `@azerothian/gqlize-adapter-sequelize` | [`@azerothian/ormize-adapter-sequelize`](../packages/ormize-adapter-sequelize) |
| `@azerothian/gqlize-shared` | [`@azerothian/utilize`](../packages/utilize) |
| `@vostro/graphql-types` | [`@azerothian/graphql-types`](../packages/graphql-types) |
| `graphql@npm:@vostro/graphql16` | `graphql@^17` + a [pnpm patch](#4-the-graphql-patch) |
| — | [`@azerothian/ormize-adapter-valkey`](../packages/ormize-adapter-valkey) |
| — | [`@azerothian/ormize-zod4`](../packages/ormize-zod4) |
| — | [`@azerothian/nestize`](../packages/nestize) |

All eight publish in lockstep on one version. The adapter packages take `@azerothian/ormize` and
`@azerothian/gqlize` as peer dependencies, so keep them on matching versions.

`GqlizeAdapter` was also split. The backend contract is now `OrmAdapter` (in `utilize`, GraphQL-free);
`GqlizeAdapter extends OrmAdapter` (in `gqlize`) adds the GraphQL-specific members. A custom adapter
that never touches GraphQL only needs to implement `OrmAdapter`.

## 2. Mechanical migration

### Requirements

- **Node.js ≥ 24.** 7.x targets Node 24; earlier majors are not supported.
- **`graphql@^17.0.0`.** The `@vostro/graphql16` fork is gone.
- **`sequelize@^6.35.1`**, **`graphql-relay@^0.10`** — unchanged from 6.x.

### Install

```sh
# remove
npm rm @azerothian/gqlize-adapter-sequelize @vostro/graphql-types @vostro/graphql16

# add
npm i @azerothian/ormize @azerothian/gqlize @azerothian/ormize-adapter-sequelize
npm i graphql@^17 graphql-relay@^0.10 sequelize@^6
```

Drop the `resolutions` / `overrides` entry pointing `graphql` at `npm:@vostro/graphql16` — see
[§4](#4-the-graphql-patch) for what replaces it.

### The entry point

`Database` is gone, and `createSchema` no longer builds its own manager. Construct an `Ormize`, then
hand it to `createSchema`.

**6.x**

```ts
import { Database, createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";

const db = new Database();
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");
await db.addDefinition(TaskDefinition);
await db.initialise();
await db.sync();

const schema = await createSchema(db);
```

**7.x**

```ts
import { Ormize } from "@azerothian/ormize";
import { createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

const db = new Ormize();
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");
await db.addDefinition(TaskDefinition);
await db.initialise();
await db.sync();

const schema = await createSchema(db, options);
```

`registerAdapter`, `addDefinition`, `define`, `initialise`, `sync`, `reset`, `models`, `getModel` and
the hook API all keep their 6.x signatures — only the class name and the import path change. Model
definitions themselves need no edits.

`createSchema(orm, options)` wraps the instance in an internal `GqlizeBinding`; you never construct
that yourself. `options` (permissions, hooks, naming) is unchanged from 6.x.

### Imports

| 6.x import | 7.x import |
| --- | --- |
| `import { Database } from "@azerothian/gqlize"` | `import { Ormize } from "@azerothian/ormize"` |
| `import { createSchema } from "@azerothian/gqlize"` | unchanged |
| `import Events from "@azerothian/gqlize/lib/events"` | `import { Events } from "@azerothian/ormize"` |
| `import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize"` | `from "@azerothian/ormize-adapter-sequelize"` |
| `import { Definition, ... } from "@azerothian/gqlize/lib/types"` | `from "@azerothian/utilize"` |
| `import { GraphQLJSON } from "@vostro/graphql-types/lib/json"` | `from "@azerothian/graphql-types/json"` |

Every package publishes ESM (`lib/index.mjs`), CJS (`cjs/index.js`) and types via an `exports` map,
so deep `lib/...` paths are no longer needed — and mostly no longer resolve. Import from the package
root, or from a declared subpath in the case of `graphql-types`.

## 3. Behavioural changes

These are the changes that break working 6.x code without a rename to guide you.

### Mass assignment: primary keys and foreign keys are no longer writable

In 6.x every column in a definition became a mutation input field. A client could therefore forge a
record's `id`, or reassign its owner/tenant by writing the foreign key directly (IDOR).

In 7.x a structural guard runs *before* any permission predicate: **primary keys and foreign keys are
excluded from create and update inputs by default.** A field opts back in explicitly:

```ts
{
  name: "Task",
  define: {
    externalRef: { type: DataTypes.STRING, primaryKey: true, writable: true },
  },
}
```

This is deliberately independent of your `permission` config — a permissive predicate does not
re-enable it. `writable: true` is the only opt-in.

Columns marked `autoPopulated` are **not** excluded: in this codebase `autoPopulated` also covers any
column with a `defaultValue`, which is legitimate client input. Auto-increment primary keys are
already covered by the primary-key rule.

> **Watch for:** a mutation that used to set a relationship by writing `taskId` directly now silently
> ignores that field. Set relationships through the nested relationship inputs instead (see
> [guide.md § Nested relationship writes](guide.md#nested-relationship-writes)), or add
> `writable: true` if you genuinely want the raw FK exposed.

### Pagination is bounded: 100 by default, 1000 maximum

In 6.x a list query with no `first`/`last` produced an unbounded `findAll` — a full-table dump — and
an over-large `first` was passed straight through.

7.x clamps every list query, at the adapter, through the single path all list reads funnel into:

| | Value |
| --- | --- |
| No `first`/`last` supplied | `100` |
| `first`/`last` above the cap | clamped to `1000` |
| Nested (`include`) connections | clamped to `1000` |

The same bounds apply to nestize's REST list routes, since both projections share
`processListArgsToOptions`. The constants are exported if you need to reference them:

```ts
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@azerothian/ormize-adapter-sequelize";
```

> **Watch for:** code that assumed an unpaginated list returned *everything*. Anything relying on that
> needs to page explicitly.

### Regex `where` operators are opt-in

`$regexp`, `$notRegexp`, `$iRegexp` and `$notIRegexp` let a client push an arbitrary pattern into the
database — a ReDoS vector. They are no longer generated unless the adapter is constructed with the
flag:

```ts
new SequelizeAdapter({ enableRegexpOperators: true }, { dialect: "postgres" });
```

Without it those operators are absent from the generated filter input type, so queries using them
fail validation rather than failing silently.

### Filter, order and include input types are permission-gated

In 6.x the `permission` config gated *output* fields and mutation inputs, but the generated `where`
and `orderBy` input types still enumerated every column. A caller could filter or sort on a field they
could not read, and infer its value — a classic blind-filter oracle.

7.x threads the build-time permission into type generation via `adapter.setBuildPermission(permission)`,
which `createSchema` calls for you. Fields your permission config denies no longer appear in `where`,
`orderBy`, or the nested `include` args.

> **Watch for:** queries that filter or sort on a denied field now fail schema validation
> (`Field "x" is not defined by type "TaskFilterInput"`) rather than returning results. If a field
> should be filterable, it must be readable.

### `node(id)` goes through the authorized path

The Relay `node(id: ID!)` root field previously fetched by decoded id directly, bypassing the
permission and hook chain the equivalent list/single query goes through. It now routes through the
authorized path, and the global-id decode has a stricter guard: a malformed or cross-type id is
rejected instead of being coerced.

> **Watch for:** `node()` lookups that only worked because they skipped your permission config now
> return `null`.

### Relay `pageInfo` is derived from the window's absolute position

`hasNextPage` / `hasPreviousPage` are now computed from the returned window's absolute offset within
the full result set, rather than inferred from the size of the fetched batch. Forward pagination
(`first`/`after`) now reports correctly at the boundaries where 6.x did not.

> **Known issue:** backward pagination (`last` / `before`) still returns the wrong rows at the data
> layer. This is a pre-existing adapter bug that predates 7.0 and is **not** fixed in this release.
> Prefer forward pagination.

### Mutations run in a transaction

Create, update and delete now wrap their work — including nested relationship writes and the hook
chain — in a transaction, so a failure partway through a nested mutation rolls the whole thing back
instead of leaving half-written rows.

> **Watch for:** hooks that performed their own writes through a *separate* connection will no longer
> see the in-flight mutation's rows, and their writes will not roll back with it. Use the transaction
> supplied in the hook context.

### `createListObject` takes a data-source descriptor, not a resolver

Only affects code that imports the schema builders directly
(`@azerothian/gqlize/graphql/create-list-object`). The ordinary
`createSchema(orm, options)` surface is unchanged.

The fifth parameter was a `resolveData` closure; it is now a `DataSourceDescriptor` — plain data
describing *where* the page comes from, so the same connection can be rebuilt from a serialized
schema (see [§5, schema artifacts](#5-new-in-7x)). The resolver body moved to
`src/graphql/resolvers/connection.ts`.

```ts
// 6.x
createListObject(instance, cache, "Task", TaskType,
  async (args, context, info) => instance.resolveFindAll("Task", args, context, info));

// 7.x
createListObject(instance, cache, "Task", TaskType,
  {source: "findAll", defName: "Task"});

// ...and for a relationship-backed connection
createListObject(instance, cache, "Task", TaskType,
  {source: "manyRelationship", defName: "Item", relName: "tasks", targetDefName: "Task"});
```

The same rule applies anywhere a resolver is attached inside the builders: they go through
`bindField(config, binding, ctx)`, which both installs the resolver and records the descriptor on
`extensions.gqlize`. A field with a `resolve` but no descriptor makes `snapshotSchema` throw —
deliberately, since the alternative is a materialized field that silently returns `undefined`.

### Role-based permissions now gate `extend` fields and mutation inputs

`createRoleBasedPermissions` compiled four callbacks nothing has ever read — `subscription`,
`mutationUpdateAll`, `mutationDeleteAll` and `extensions` — while never compiling four that gqlize
does read: `queryExtension`, `mutationExtension`, `mutationCreateInput` and `mutationUpdateInput`.
Since an absent predicate means *allow*, that gap was a hole rather than a no-op: under
`defaultDeny: true` a role-based bag denied models, fields and mutations as advertised, but let every
`options.extend.query` / `extend.mutation` root field and every mutation input field straight
through.

7.x compiles exactly the callbacks listed in [specifications.md §7](specifications.md#7-permissions).
Two rules keys feed more than one callback, so a `defaultDeny` role stays usable:

- `extensions` is accepted as a synonym for both `queryExtension` and `mutationExtension` — the key
  6.x emitted (inertly) is now the one that works.
- `mutationCreateInput` / `mutationUpdateInput` fall back to `field`, matching the rule the
  `where` / `orderBy` tightening above already applies: if a field should be writable, it must be
  readable. Without this fallback a `defaultDeny` role would deny every input field, leaving the
  input object empty and deleting its create/update mutations outright.

The more specific key wins wherever both express an opinion, and an explicit `"deny"` on the
specific key is never overridden by an `"allow"` on the fallback.

> **Watch for:** roles that exposed `extend` root fields or mutation inputs by omission now have to
> name them. Add `queryExtension: { health: "allow" }` (the key is the **extend field key**, not a
> model name), or grant the field for reading and let the input fallback pick it up. A rules key
> outside the accepted set — `subscription`, or a typo — is now reported on `console.warn` instead of
> being compiled into a predicate nobody calls.

### Unknown `permission` keys are a type error, and warn at build time

`createSchema(orm, options)` typed `options` as `any` in 6.x, so a misspelled predicate
(`modle`, `mutationCreateInputs`) typechecked, was never called, and — because an absent predicate
means *allow* — silently produced a **wider** schema than intended.

`Permission`, exported from `@azerothian/utilize`, is now a **closed** shape — sixteen optional
predicates and no index signature — and it is the type behind every package's `permission?:`
option: `createSchema`, `generateZodSchemas`, nestize's `NestizeOptions`, and whatever
temporalize's `resolvePermission` returns. A stray key is a compile error with a "did you mean"
suggestion. In 6.x the type carried `[key: string]: any`, which defeated the excess-property check
outright, so every one of those surfaces failed open on a typo.

For JavaScript callers and bags built programmatically the compiler cannot help, so `createSchema`
also warns on `console.warn` naming the unknown keys. It warns rather than throws, so an existing
bag still builds.

`PERMISSION_KEYS` is the machine-readable copy of the same set, and a compile-time guard now holds
the two together — adding a predicate to one and forgetting the other no longer compiles.

> **Watch for:** the new warning firing on a bag you thought was enforcing something. That is the
> bug, not the warning.
>
> **Watch for:** every predicate is optional, so TypeScript callers that invoke one directly
> (`permission.model("Task")` in a test or a wrapper) now need `permission.model!(...)` or a
> presence check. Under `defaultDeny: false` the absent case is real — an unmentioned gate is
> genuinely omitted from the bag.

## 4. The graphql patch

6.x solved [graphql-spec #252](https://github.com/graphql/graphql-spec/issues/252) — nested mutation
fields executing in parallel rather than in order — by shipping a forked `@vostro/graphql16` and
requiring yarn `resolutions` to force it to be the only copy of graphql in `node_modules`.

7.x uses upstream `graphql@17.0.2` with a 32-line patch instead
([`patches/graphql@17.0.2.patch`](../patches/graphql@17.0.2.patch)), applied via pnpm:

```json
{
  "pnpm": {
    "overrides": { "graphql": "17.0.2" },
    "patchedDependencies": { "graphql@17.0.2": "patches/graphql@17.0.2.patch" }
  }
}
```

The patch makes `ExecutorThrowingOnIncremental` serialize top-level *and* nested mutation fields, so
an ordered relationship mutation (create → add → remove) runs sequentially.

**If your application issues nested relationship mutations that depend on ordering, you need the
equivalent patch in your own project.** Copy the patch file out of this repo and wire it into your
package manager (pnpm `patchedDependencies`, yarn `patches`, or `patch-package` for npm). Everything
else — queries, single-level mutations — works on unpatched `graphql@17`.

## 5. New in 7.x

Not required for migration, but this is what the split bought:

- **[`@azerothian/ormize-adapter-valkey`](../packages/ormize-adapter-valkey)** — a Valkey/Redis
  backend using self-maintained index and mapping structures (no keyspace scans), with FK index maps
  for relationships and `MULTI`/`EXEC` transactions.
- **[`@azerothian/ormize-zod4`](../packages/ormize-zod4)** — `generateZodSchemas(orm, options)`
  produces permission-gated entity/create/update Zod v4 schemas from the same instance.
- **[`@azerothian/nestize`](../packages/nestize)** — `NestizeModule.forRoot(orm, options)` exposes
  CRUD, relationship and `_actions` REST routes plus an OpenAPI document, with allow-list projection.
- **Cross-adapter transactions** — `orm.transaction(fn)` coordinates a rollback across adapters
  (best-effort; not two-phase commit). See
  [`examples/cross-adapter-transaction`](../examples/cross-adapter-transaction).
- **Request context** — `orm.runWithContext(ctx, fn)` / `orm.getContext()`, backed by
  `AsyncLocalStorage`.
- **Role-based permissions** — `createRoleBasedPermissions` from `@azerothian/utilize` builds a
  `permission` config from role definitions instead of hand-written predicates.
- **Abstract data types** — definitions can use the `DataType` enum, which adapters map to native
  types via `mapDataType` / `toNativeType`, so one definition works across adapters.
- **Pre-generated schema artifacts** — `gqlize build` writes the schema to a reviewable JSON
  artifact, and `loadSchema(path, orm, options)` rebuilds an executable `GraphQLSchema` from it plus
  a live ormize instance. `gqlize check` fails CI when the artifact no longer matches the
  definitions. See the [gqlize README](../packages/gqlize/README.md#pre-generated-schema-artifacts).

## 6. Checklist

- [ ] Node 24, `graphql@^17`; the `@vostro/graphql16` resolution removed.
- [ ] Packages renamed; `Database` → `Ormize` from `@azerothian/ormize`.
- [ ] Deep `lib/...` imports replaced with package-root or declared subpath imports.
- [ ] Mutations that wrote primary keys or foreign keys audited — either moved to nested relationship
      inputs or opted in with `writable: true`.
- [ ] Callers that relied on unpaginated lists updated to page explicitly.
- [ ] `enableRegexpOperators: true` set if you use `$regexp` and friends.
- [ ] `where` / `orderBy` usage checked against your permission config.
- [ ] Backward pagination (`last`/`before`) avoided — see the known issue above.
- [ ] Direct `createListObject` callers switched from a `resolveData` closure to a data-source
      descriptor.
- [ ] The graphql patch applied if you rely on ordered nested mutations.
- [ ] `createRoleBasedPermissions` rules audited for `extend` root fields and mutation inputs, which
      are now denied under `defaultDeny` instead of passing through.
- [ ] Any `subscription`, `mutationUpdateAll`, `mutationDeleteAll` rules keys removed — they gated
      nothing in 6.x and now warn.
- [ ] Hand-written `permission` bags checked against the build-time unknown-key warning.

For everything else, [**guide.md**](guide.md) is the 7.x usage guide and
[**specifications.md**](specifications.md) is the API/contract reference.
