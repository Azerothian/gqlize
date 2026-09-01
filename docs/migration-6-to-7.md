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
   - [Relay connection fields are non-null](#relay-connection-fields-are-non-null)
   - [Mutations run in a transaction](#mutations-run-in-a-transaction)
   - [`createListObject` takes a data-source descriptor, not a resolver](#createlistobject-takes-a-data-source-descriptor-not-a-resolver)
   - [Role-based permissions now gate `extend` fields and mutation inputs](#role-based-permissions-now-gate-extend-fields-and-mutation-inputs)
   - [Instance-method transforms are gated as writes everywhere](#instance-method-transforms-are-gated-as-writes-everywhere)
   - [Unknown `permission` keys are a type error, and warn at build time](#unknown-permission-keys-are-a-type-error-and-warn-at-build-time)
   - [The adapter contract is typed, and `setBuildPermission` is part of it](#the-adapter-contract-is-typed-and-setbuildpermission-is-part-of-it)
   - [Adapter list and relationship methods take a request object](#adapter-list-and-relationship-methods-take-a-request-object)
   - [Definition `type` slots are `unknown`, not `any`](#definition-type-slots-are-unknown-not-any)
   - [Multi-row mutations return every affected row](#multi-row-mutations-return-every-affected-row)
   - [Adapters agree on enum type names and enum value names](#adapters-agree-on-enum-type-names-and-enum-value-names)
   - [`field: String` works on every adapter](#field-string-works-on-every-adapter)
   - [`OrderEntry` in temporalize is now `SortEntry`](#orderentry-in-temporalize-is-now-sortentry)
   - [Unreferenced exports removed](#unreferenced-exports-removed)
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

### Relay connection fields are non-null

**This changes the SDL, and therefore the types your client codegen produces.** Five connection
fields that were nullable in 6.x are now non-null:

```diff
 type PostList {
-  pageInfo: PageInfo
+  pageInfo: PageInfo!
   total: Int
-  edges: [PostEdge]
+  edges: [PostEdge!]!
 }

 type PostEdge {
   node: Post
-  cursor: String
+  cursor: String!
 }

 type PageInfo {
-  hasNextPage: Boolean
-  hasPreviousPage: Boolean
+  hasNextPage: Boolean!
+  hasPreviousPage: Boolean!
   startCursor: String
   endCursor: String
 }
```

The first three are what the [Relay Connections spec](https://relay.dev/graphql/connections.htm)
requires. The other two are the same argument applied consistently: `resolvers/connection.ts` has
always returned an `edges` array and minted every edge's `cursor` itself, so the nullable spelling
only ever bought clients a null check they could not trigger.

`total` and `edges.node` deliberately stay nullable — `total` is a separate COUNT the include
builder may skip, and a row can be deleted between the page query and the per-edge node resolve.

**What you need to do:**

- **Rebuild your artifacts.** A pre-generated `schema.json` from 6.x carries the old shape.
  `gqlize check` will report it stale; `gqlize build` regenerates it.
- **Re-run client codegen.** Relay, graphql-codegen and Apollo's `relayStylePagination` will emit
  narrower types. Nothing breaks at runtime — the server never sent null for these — but null
  checks and `?.` on `pageInfo`, `edges`, `cursor`, `hasNextPage` and `hasPreviousPage` become
  dead code, and a strict TypeScript setup will flag them.
- **Nothing to change server-side.** No resolver, hook or permission behaviour changed.

If you generate a client from the *server's* SDL rather than your own copy, and a hand-written
schema of yours declares a field returning one of these types, note that non-null is the stricter
position: a schema that was valid against the 6.x shape stays valid against this one.

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

### Instance-method transforms are gated as writes everywhere

Same failure class as the section above — an absent predicate means *allow* — in the one place
7.0's own `expose.instanceMethods` split created it.

A definition declares instance methods once, under `options.instanceMethods`. `expose` then names
them under one of two targets: `.query` makes a method a read-only output field, `.mutations` makes
it a **pre-commit transform** that gqlize surfaces as the `apply` mutation argument and runs inside
the mutation's transaction, with writes to `this` folded back into the values being persisted. The
two targets are name-disjoint, so the target a name appears under is what says whether it reads or
writes.

Three surfaces read that namespace, and none of them read the target:

- `createRoleBasedPermissions` compiled no `mutationInstanceMethods` callback at all, even though
  gqlize consumes one and `PERMISSION_KEYS` listed it. Under `defaultDeny: true` a role-based bag
  denied models, fields and mutations as advertised and left every `apply` transform reachable.
- nestize's `POST /:resource/:id/_actions/:method` gated every method on
  `permission.queryInstanceMethods`, then called it and serialized the return value — so a
  transform ran under the *read* gate and its writes to `this` were dropped.
- temporalize's `<Model>.instanceMethods.<name>` activity did the same, inside a transaction that
  therefore committed nothing.

7.x compiles `mutationInstanceMethods`, and both projections pick the gate from the `expose` target:

| Declared under | Gate | Behaviour | Response / result |
| --- | --- | --- | --- |
| `expose.instanceMethods.mutations` | `mutationInstanceMethods`, **and** the model's `mutationUpdate` gate (plus `readOnly`) | run through `processUpdate` with an empty input and an `apply` bag — the same path gqlize's `apply` takes, so it gets the transaction, the recording proxy and scope enforcement | the persisted row |
| `expose.instanceMethods.query`, or neither target | `queryInstanceMethods` | load the row by primary key and call the method | whatever the method returned |

Enumeration is unchanged: it is still driven by `options.instanceMethods`, so a definition with no
`expose` block at all keeps every method, every gate and every response exactly as they were in 6.x.
Only names present under `.mutations` change lane.

Two smaller alignments come with it. `mutationInstanceMethods` naming which transforms a role may
run never implied the role may write at all, so a transform now also passes the model's
`mutationUpdate` gate, as every other write route already did. And in **both** projections
`readOnly` no longer refuses a `.query`-target instance method — nor one declared under neither
target — because those are reads. Only a transform is a write, and only a transform is refused.

> **Watch for:** three changes, in the order they will bite. (1) A `.mutations`-target method now
> needs `permission.mutationInstanceMethods`; a role bag that granted only `queryInstanceMethods`
> loses access, and under `defaultDeny` a bag that granted neither loses the `apply` argument from
> the schema entirely — add `mutationInstanceMethods: { Task: { appendSuffix: "allow" } }`.
> (2) The REST response body and the activity result **change shape** for transforms: previously the
> method's return value, now the persisted row, matching every other write route in those packages.
> (3) Transform writes now commit. Anything that depended on them being dropped was depending on the
> bug.

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

### The adapter contract is typed, and `setBuildPermission` is part of it

Only relevant if you maintain your own adapter. `OrmAdapter` and `GqlizeAdapter` described most of
their surface as `any`; they now name the things that flow through them —
`AdapterQueryOptions`, `AdapterWhere`, `AdapterRow`, `AdapterTransactionHandle`, `NativeDataType`,
`AdapterCreateFunction` / `AdapterUpdateFunction` / `AdapterDeleteFunction`, and
`AdapterRelationshipPage` for what a `resolveManyRelationship` hop returns (`{total, models}`).

`AdapterRow` is `unknown`, so a *caller* cannot read a column off a row without saying what it
expects. The members are declared with method syntax, which keeps parameters bivariant: your
implementation may still narrow a row to your own instance type
(`update(row: MyModel, ...)`) without a cast.

`setBuildPermission` is now declared — optional — on `GqlizeAdapter`. It was already implemented by
both bundled adapters and already called by `createSchema`, but through a
`typeof adapter.setBuildPermission === "function"` duck-type check, so an adapter that misspelled it
silently lost filter/order/include gating. Declaring it means the compiler catches that. If your
adapter builds those three input types from a permission bag, implement it; if its builders take the
permission explicitly, leave it off.

> **Watch for:** `createRelationship`'s fifth parameter is `Relationship["options"]`, whose `through`
> is `string | {model?, foreignKey?, otherKey?}`. Adapters that only ever destructured the object
> form need a `typeof === "object"` guard before reading `.model`.

`SchemaCache` moved from `@azerothian/utilize` to `@azerothian/gqlize`, and is no longer twelve
`{[x: string]: any}` buckets. Every bucket holds a `graphql` type, so it could never be described in
a package that must not import `graphql`. Import it from `@azerothian/gqlize` (or
`@azerothian/gqlize/types/index`, which is where it already resolved from for anyone using the
gqlize barrel). The buckets are keyed differently from each other — `types` and
`mutationInputFields` by type name, the `*Fields` buckets by model name, the class-method and
mutation-model buckets flat — which the shared `any` shape hid.

`Selection.include` is now `IncludeMap[]` rather than `any[]`. `IncludeDescriptor` and `IncludeMap`
moved the other way, from gqlize into `@azerothian/utilize`, since they are what the graphql-free
hand-off actually carries; `@azerothian/gqlize/graphql/utils/build-include-from-selection` still
re-exports both. `Definition.ignoreFields` is `string[]` and `Definition.comments` is a
`DefinitionComments` (`{fields?, classMethods?, instanceMethods?}`).

### Adapter list and relationship methods take a request object

Only relevant if you maintain your own adapter, or call these three directly. Their interchangeable
tail of positional parameters is now one named-field object:

```ts
// 6.x
processListArgsToOptions(defName, args, offset, selection, whereOperators, graphQLArgs, selectedFields, runHook)
resolveManyRelationship(defName, association, source, args, offset, whereOperators, selection, options, countOnly)
resolveSingleRelationship(defName, association, source, args, context, selection, options)

// 7.x
processListArgsToOptions(defName, request: AdapterListRequest)
resolveManyRelationship(defName, association, source, request: AdapterRelationshipRequest)
resolveSingleRelationship(defName, association, source, request: AdapterRelationshipRequest)
```

`AdapterListRequest` is `{args, offset?, selection?, whereOperators?, options?, selectedFields?,
runHook?}`; `AdapterRelationshipRequest` adds `countOnly?` and `context?`. A call site migrates by
naming what it was passing:

```ts
// 6.x
const {getOptions} = await adapter.processListArgsToOptions(defName, args, offset, selection, ops, options, fields, runHook);
// 7.x
const {getOptions} = await adapter.processListArgsToOptions(defName, {
  args, offset, selection, whereOperators: ops, options, selectedFields: fields, runHook,
});
```

Three things the positional form was hiding, all fixed by the move:

- **The contract and the implementations disagreed.** `processListArgsToOptions` declared
  `graphQLArgs` at position six; every implementation used that slot for `defaultOptions`. The bag
  is `{[key: string]: any}`, so nothing caught it. That parameter is now `options`, which is what it
  always was.
- **`beforeFind` now fires for JOIN-loaded includes on the relationship path.** *This is a behaviour
  change.* The Sequelize adapter's internal call inside `resolveManyRelationship` passed six of the
  eight arguments, silently dropping `selectedFields` and `runHook` — so a JOIN include reached
  through a relationship never got its child model's `beforeFind` fired, while the same include
  reached from a root query did. If you use `beforeFind` to add a tenancy filter, it now applies on
  both paths; if you use it for logging or metrics, expect more calls. The same fix means
  `selectedFields` reaches the relationship query, so it fetches the selected columns rather than
  every column.
- **Caller options no longer override computed ones.** `processListArgsToOptions` built its result
  as `Object.assign({...computed}, defaultOptions)` — `defaultOptions` last, so a caller-supplied
  `attributes` silently replaced the adapter's computed primary-key/selected-field list *and* its
  inline-count column. The computed values now win. If you were relying on passing `attributes`
  through `options` to widen a query, select the fields instead.

`processListArgsToOptions` also returns a named `AdapterListOptions` (`{getOptions, countOptions?}`)
rather than the untyped bag. `countOptions` is optional exactly when the adapter counts inline; an
adapter that reports `hasInlineCountFeature() === false` and returns no `countOptions` now gets a
clear error instead of an unfiltered count.

### Definition `type` slots are `unknown`, not `any`

`DefinitionField.type`, `Definition.override.*.type` / `.inputType` and the four
`Definition.expose.*.type` slots are now `unknown`. Nothing changes for authoring a definition:
`unknown` accepts every value, so `type: DataTypes.String`, `type: GraphQLString` and
`type: {name: "Point", fields: {...}}` all still assign. They cannot be typed more tightly here,
because what belongs in them is a `DataType` member, an adapter-native type *or* a `graphql` type —
and `@azerothian/utilize` must not import `graphql`.

What changes is *reading* them. Code that pulled a property straight off one of these slots now has
to narrow first, which is what the builders already did at runtime:

```ts
// before — `any`, so this compiled whether or not the author supplied a built type
const name = definition.override.point.type.name;

// after — say which form you are handling
import {isBuiltOutputType} from "@azerothian/gqlize/graphql/utils/authored-type";

const slot = definition.override.point.type;
const type = isBuiltOutputType(slot)
  ? slot                                                  // already a GraphQLObjectType/Scalar/Enum
  : new GraphQLObjectType(slot as GraphQLObjectTypeConfig<any, any>);  // a config for one
```

`isBuiltOutputType` / `isBuiltInputType` and the `AuthoredTypeSlot` shape (`{name, fields?}` — what
both forms have in common) are exported from
`@azerothian/gqlize/graphql/utils/authored-type` for exactly this.

Two smaller consequences, both only visible to code that touches the internals: `recordExternalType`
now accepts any `GraphQLType`, wrappers included, rather than only named types — it unwraps with
`getNamedType` and always did. And `SchemaCache.mutationInputFields` is `GraphQLNullableInputType`,
since the bucket only ever holds an input object or a list of one; callers apply
`GraphQLNonNull` themselves.

### Multi-row mutations return every affected row

`update`, `delete`, `select` and `restore` take a filter, so one argument can match many rows.
They now return all of them; previously the returned list held only the **last** row the filter
matched, and an empty match returned `[null]` rather than `[]`.

```graphql
mutation { models { Post(delete: { title: { in: ["a", "b"] } }) { id } } }
# now:      { "Post": [{"id": "…a"}, {"id": "…b"}] }
# before:   { "Post": [{"id": "…b"}] }
```

The rows written were always correct — only the mutation's own return value was truncated. Code
that read `data.models.Post[0]` after a single-row filter is unaffected; code that counted the
returned array, or that tested for `[null]` to detect "nothing matched", needs updating.

### Adapters agree on enum type names and enum value names

Enum handling had drifted between the two shipped adapters. The sequelize adapter capitalised the
generated type name and sanitised each member into a legal GraphQL name; the valkey adapter did
neither. Both now go through one implementation, `createEnumType` in `@azerothian/graphql-types`.

Two consequences, both on the **valkey** adapter only — the sequelize adapter's output is unchanged.

**Enum type names are now capitalised.** A model `Task` with an enum field `status` generated
`TaskstatusEnum` and now generates `TaskStatusEnum`, matching what the sequelize adapter has always
emitted. A persisted schema artifact built against the valkey adapter must be rebuilt, and a client
that named the old type in a query or a generated-types file needs regenerating.

**Enum members that are not legal GraphQL names now work instead of throwing.** GraphQL names must
match `/^[_a-zA-Z][_a-zA-Z0-9]*$/`. A member such as `in-progress` or `2xl` was previously used
verbatim as the enum value name, and graphql rejected it — with the throw landing not at
`new GraphQLEnumType` (which builds its values lazily) but wherever something first materialised
them, naming `assertEnumValueName` rather than the definition that declared the member. Such members
are now sanitised the way the sequelize adapter has always sanitised them:

| Declared member | GraphQL enum value name | Value sent to the backend |
|---|---|---|
| `in-progress` | `inProgress` | `in-progress` |
| `2xl` | `_2xl` | `2xl` |
| `done` | `done` | `done` |

Only the schema-facing name changes; the value that reaches the database is the member exactly as
declared. Two members that differ only in punctuation (`in-progress` and `in progress`) now raise a
build-time error naming both, rather than silently collapsing into one value and leaving the loser
unqueryable.

### `field: String` works on every adapter

A definition could author a field type as a bare JavaScript constructor — `type: String`,
`type: Number`, `type: Boolean`, `type: Date`, `type: BigInt`, `type: Array`, `type: Object` — and
the valkey adapter accepted it. The sequelize adapter did not: it recognised only `DataTypes.*`
tokens, so the constructor reached `sequelize.define` untouched, where `normalizeDataType` turned
`String` into a `String` **wrapper object** with no `.key`. That is not a valid Sequelize type, and
it failed later during DDL generation rather than at define time.

The mapping now lives in one place, `authoredDataType` in `@azerothian/utilize/types/data-type`, and
both adapters consult it — so the same definition builds on both. `Number` maps to `Int`, not
`Float`: JavaScript has a single numeric type and no way to say which was meant, and silently
widening an id column to floating point loses precision. Author `DataTypes.Float` to say otherwise.

This is additive on sequelize — nothing that worked before stops working.

### `OrderEntry` in temporalize is now `SortEntry`

`@azerothian/temporalize` exported `OrderEntry` (`string | [string, string]`), and
`@azerothian/utilize` exports a different, non-assignable `OrderEntry` (`[column, direction]`, no
bare-string form). Both are on their packages' public barrels and temporalize depends on utilize, so
importing both gave you two same-named types that do not substitute for each other.

The shapes differ for a good reason — the bare string is a convenience temporalize accepts and
passes through untouched — so the fix is one name each, not one type. Rename any import of
`OrderEntry` from `@azerothian/temporalize` to `SortEntry`. `@azerothian/utilize`'s `OrderEntry` is
unchanged.

### Unreferenced exports removed

Eight exports had no consumer inside the repo and none documented outside it. They are gone in 7.x.
Each was either dead on arrival or superseded by something already exported alongside it.

| Removed | Package / module | Replacement |
|---|---|---|
| `defaultConfig` | `@azerothian/graphql-types` (`query`) | None — it was never a valid `QueryTypeConfig` (it carried a `getFieldType()` member the interface does not declare). Build the config from your adapter's operator vocabulary and pass it to `createQueryType`. |
| `globalIdField` | `@azerothian/gqlize` (`graphql/utils/global-id-field`) | `globalIdFieldConfig(isNullable)` — the same `{description, type}` half, without the resolver. The live schema builders already used it; the resolver half is bound in `graphql/resolvers`. |
| `mustResolveModel` | `@azerothian/temporalize` (`guards`) | `isModelAllowed` plus your own throw, which is what every call site did. |
| `MUTATION_OPS` | `@azerothian/temporalize` (`workflow-types`) | None — the workflow entry points switch on the operation name directly. |
| `FieldBindingKind`, `BindingHandler` | `@azerothian/gqlize` (`graphql/resolvers/types`) | None — an abandoned first cut at the resolver-binding registry, which shipped keyed by `ResolverKind` instead. |
| `DataType` (re-export) | `@azerothian/ormize-adapter-valkey` (`data-type-mapper`) | Import it from its home, `@azerothian/utilize/types/data-type`. |
| `lowecase` | `@azerothian/utilize` (`utils/word`) | `lowercase` — `lowecase` was a misspelled alias kept for 6.x compatibility. |

Also removed: two empty `types/modules.d.ts` ambient-declaration files (`gqlize`, `ormize`) and the
vendored lodash `_.property` port in `graphql-types`. Neither was importable as a public subpath.

The build now runs with `noUnusedLocals`, so an import or local that nothing reads is a compile
error rather than something that accumulates. If you extend this repo, expect `tsc` to reject
placeholder bindings — drop the binding and keep the call.

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
- **`@deprecated`** — a `deprecated` reason on a column, an exposed method or a whole definition,
  or a central `deprecations` map for declarations you did not author (relationships, inherited
  columns). It reaches the output field, the mutation input, both halves of the `orderBy` enum pair
  and the model's root fields, and survives the artifact round-trip. 6.x had no way to deprecate
  anything, so renaming a column was a hard break with no warning path. See
  [guide: Deprecating fields](guide.md#deprecating-fields).
- **Soft delete (`paranoid`)** — a paranoid model's list fields take a
  `deleted: EXCLUDE | INCLUDE | ONLY` argument (root and nested alike, plus the `include` input),
  and its mutation field takes `restore`. Paranoid itself is enabled per model with
  `options: {paranoid: true}` or for every model at once with the Sequelize adapter's
  `defaultModel`, which a definition's own `options` override. Two new build-time permission keys
  gate the pair: `queryDeleted` and `mutationRestore`. In 6.x a soft-deleted row was unreachable
  through GraphQL by any means and there was no root-level restore. See
  [guide: Soft delete](guide.md#soft-delete-paranoid).
- **Build-time schema validation** — `createSchema` and `materializeSchema` now run graphql's
  `validateSchema` and throw on failure, so an invalid `options.root` / `options.extend` /
  `override` type is an error where it was written instead of an error on *every* query at request
  time. `options.validate: false` opts out. See
  [guide: Build-time validation](guide.md#build-time-validation-optionsvalidate).

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
- [ ] Schema artifacts rebuilt and client codegen re-run for the non-null connection fields.
- [ ] The build checked against the new schema validation — a schema that was quietly invalid in
      6.x now throws from `createSchema`.
- [ ] Any `subscription`, `mutationUpdateAll`, `mutationDeleteAll` rules keys removed — they gated
      nothing in 6.x and now warn.
- [ ] Callers that read the return value of a multi-row `update` / `delete` / `select` audited —
      the list now holds every affected row, and an empty match is `[]` rather than `[null]`.
- [ ] Hand-written `permission` bags checked against the build-time unknown-key warning.
- [ ] Third-party adapters recompiled against the typed `OrmAdapter` / `GqlizeAdapter`, and
      `setBuildPermission` implemented if their filter/order/include builders gate on a permission
      bag.
- [ ] Code that *reads* a definition's `type` / `inputType` slot narrows it — `isBuiltOutputType` /
      `isBuiltInputType` — instead of reading properties off what used to be `any`. Authoring a
      definition is unaffected.

For everything else, [**guide.md**](guide.md) is the 7.x usage guide and
[**specifications.md**](specifications.md) is the API/contract reference.
