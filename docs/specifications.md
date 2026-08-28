# gqlize — Technical Specification

> **Status:** As-built specification. This document describes the system as it exists in
> the code today (version `6.0.0`). It is descriptive, not a requirements wishlist —
> unimplemented ideas are collected in [§13 Known Gaps / Roadmap](#13-known-gaps--roadmap).
> Source of truth is `packages/*/src`; file paths are given throughout so every claim can
> be checked against the code.
>
> **Looking for how-to examples?** See the [**Usage Guide**](guide.md) — this document is the
> reference; the guide is the tutorial/cookbook.

---

## Table of Contents

1. [Overview & Purpose](#1-overview--purpose)
2. [Architecture & Package Layout](#2-architecture--package-layout)
3. [Public API & Usage Lifecycle](#3-public-api--usage-lifecycle)
4. [Model Definition Schema](#4-model-definition-schema)
5. [Generated Schema Shape](#5-generated-schema-shape)
6. [Relay Connections & Global IDs](#6-relay-connections--global-ids)
7. [Permissions](#7-permissions)
8. [Lifecycle Hooks & Events](#8-lifecycle-hooks--events)
9. [Adapter Contract](#9-adapter-contract)
10. [Custom Scalars](#10-custom-scalars)
11. [Build, Test & Tooling](#11-build-test--tooling)
12. [The graphql Patch](#12-the-graphql-patch)
13. [Known Gaps / Roadmap](#13-known-gaps--roadmap)

---

## 1. Overview & Purpose

**gqlize** is a relational *databinder* that automatically generates a Relay-style GraphQL
schema over one or more data sources through pluggable **adapters**. Given a set of model
definitions, it produces a complete GraphQL schema — object types, Relay connections,
queries, and deep nested mutations — so consumers do not hand-write resolvers or SDL.

It was previously published as [`sql2gql`](https://github.com/VostroNet/sql2gql/tree/v3).

Distinguishing characteristics:

- **Adapter-based, multi-datasource** — the schema generator is decoupled from any specific
  ORM/database via the `GqlizeAdapter` contract; Sequelize is the reference implementation.
- **Fine-grained permissions** — per-model, per-field, per-operation, per-relationship, and
  per-class-method gates, plus a role-based helper.
- **Lifecycle hooks** — both Sequelize-style lifecycle hooks and gqlize-level `before`/`after`
  transforms keyed by an `Events` enum.
- **Deep nested mutations** — create/update/delete/add/remove/set/restore (+ belongsToMany
  `through` attributes) across relationships in a
  single mutation.
- **Relay global IDs & connections** — opaque IDs on primary/foreign keys with automatic
  translation, and a custom connection shape that carries a `total`.

Metadata: version `6.0.0`, MIT licensed, npm scope `@azerothian`, Node.js ≥ 24.

---

## 2. Architecture & Package Layout

The repository is a **pnpm workspaces + Turborepo** monorepo. The dependency graph is
acyclic:

```
graphql-types (leaf)
utilize (leaf) ──► ormize (backend) ──► gqlize (graphql) ──► ormize-adapter-sequelize (adapter)
                              └────────► ormize-zod4 (zod)
                              └────────► nestize (nestjs rest)
```

**Package architecture:** `graphql-types` + `utilize` form the base layer. `ormize`
builds on that base to provide the GraphQL-free backend manager. `gqlize` (GraphQL),
`ormize-zod4` (Zod) and `nestize` (NestJS REST) are three **projections** of one `Ormize`
instance. The sequelize adapter implements `GqlizeAdapter` (the graphql-typed adapter contract,
which now lives in `gqlize`) and is registered on an `Ormize` instance.

| Package | Path | Responsibility |
| --- | --- | --- |
| [`@azerothian/ormize`](../packages/ormize) | `packages/ormize` | GraphQL-free backend manager: `Ormize` class (`src/manager.ts`), `registerAdapter`, fluent `define()`, `addDefinition`, `models`, hooks, `getAssociations`/`getFields`/`getGlobalKeys`, `initialise`/`sync`/`reset`, relationship wiring, the graphql-free resolution engine (`resolveFindAll`/`process*`/`resolve{Many,Single}Relationship`), and the generic (adapter-agnostic) typed-model system. No GraphQL dependency. |
| [`@azerothian/gqlize`](../packages/gqlize) | `packages/gqlize` | GraphQL layer: `createSchema(orm, options)` accepts an `Ormize` instance and generates the full Relay-style schema. Key files: `src/graphql/*` (builders), `src/graphql/resolvers/*` (the resolver registry), `src/graphql/snapshot/*` (serialisation), `src/cli/*` (the `gqlize` binary), `src/types/gqlize-adapter.ts` (the `GqlizeAdapter` contract). |
| [`@azerothian/ormize-zod4`](../packages/ormize-zod4) | `packages/ormize-zod4` | Zod v4 projection: `generateZodSchemas(orm, options)` → permission-gated `{ entity, create, update }` schemas per model. |
| [`@azerothian/nestize`](../packages/nestize) | `packages/nestize` | NestJS REST + Swagger projection: `NestizeModule.forRoot(orm, options)` + `buildOpenApiDocument`/`setupSwagger`. Drives the graphql-free ormize engine over REST; request bodies validated with the ormize-zod4 schemas. |
| [`@azerothian/ormize-adapter-sequelize`](../packages/ormize-adapter-sequelize) | `packages/ormize-adapter-sequelize` | Reference `GqlizeAdapter` implementation over Sequelize 6. Same `SequelizeAdapter` default export. Entry: `src/index.ts`; `src/type-mapper.ts`, `src/utils/where-ops.ts`, `src/utils/replace-id-deep.ts`. Typesystem binding in `src/types/orm.ts` (`defineModel`, `SequelizeModel`, `IORSequelizeModel`). |
| [`@azerothian/utilize`](../packages/utilize) | `packages/utilize` | Shared, GraphQL-free foundation: `OrmAdapter` (backend adapter contract), `Definition`, `DefinitionField*`, `Association`, `Relationship`, `WhereOperators`, `Selection`, `DataType`/`DataTypes`, options/cache types; the generic definition typesystem (`src/types/orm.ts`: `ITypedDefinition`, `IORModel`); the `Events` enum; permission gate helpers + `createRoleBasedPermissions` (`src/gate.ts`, `src/permissions.ts`); and utilities (`logger`, `unique`, `word`, `waterfall`). |
| [`@azerothian/graphql-types`](../packages/graphql-types) | `packages/graphql-types` | Custom GraphQL scalars (`json`, `date`, `bigint`, `ip`, `upload`) and `createQueryType`. A local copy of `@vostro/graphql-types`. |

> **Runnable examples:** [`examples/gqlize-basic`](../examples/gqlize-basic) (GraphQL) and
> [`examples/nestize-rest`](../examples/nestize-rest) (REST) build the same domain on one ormize
> instance — see the [root README](../README.md#examples).

### Schema serialisation subsystem (`packages/gqlize`)

Three directories exist so a schema can be built once and rebuilt from an artifact later. The
design property they all serve is **one resolver implementation, two callers**:

| Path | Responsibility |
| --- | --- |
| `src/graphql/resolvers/` | Every resolver body, keyed by `kind` (`connection`, `singleRelationship`, `globalId`, `modelField`, `overrideOutput`, `instanceMethod`, `classMethod`, `mutationModel`, `container`, `nodeField`, `extend`). `bind.ts` exports `bindField(config, binding, ctx)` — the **single** point at which any resolver is attached to any field, and the place the `FieldBinding` descriptor is stamped onto `extensions.gqlize`. |
| `src/graphql/snapshot/` | `ir.ts` (the serialisable `SchemaSnapshot`), `snapshot.ts` (`GraphQLSchema` → IR), `materialize.ts` (IR → `GraphQLSchema`), `fingerprint.ts`, `scalar-registry.ts`, `type-ref.ts`, `reachability.ts`, `ledger.ts`, `load.ts`. |
| `src/cli/` | `args.ts` (`node:util.parseArgs`), `config.ts` (discovery + loading), `profiles.ts`, `commands/{build,print,check}.ts`, and `index.ts` — the shebang shell that turns `run()`'s return value into an exit status. |

The live builder and the materializer both call `bindField`, so there is no second resolver
implementation that could drift from the first. Enforcing that, the snapshotter **throws** rather
than silently dropping anything it cannot describe: a `resolve`/`subscribe` with no binding, a
non-`Node` `resolveType`/`isTypeOf`, a non-JSON-serialisable enum internal value, an unregistered
scalar, or a non-representable default — each reported with its schema coordinate.

The artifact is JSON rather than SDL because `printSchema` discards enum *internal* values (the
`["name", "ASC"]` payloads behind `*OrderBy` members, fed straight to the adapter's `order`) and
never prints applied directives. SDL is available as a secondary artifact for codegen and CI diffs.

Root configuration files: `package.json` (scripts, `pnpm@11.23.0`), `pnpm-workspace.yaml`
(`packages/*`, `examples/*`, `tools/*`, plus the graphql override/patch, the peer-dependency
rules and the `allowBuilds` verdicts - pnpm 11 no longer reads a `pnpm` field from
`package.json`), `turbo.json` (task pipeline), `tsconfig.base.json`
(shared compiler options + `@azerothian/*` → `src/` path aliases), `tsconfig.json`
(`tsc -b` project references), and `patches/graphql@17.0.2.patch`.

---

## 3. Public API & Usage Lifecycle

The ormize package (`packages/ormize/src/index.ts`) exports the backend manager:

```ts
export class Ormize { /* GQLManager — registerAdapter, define, addDefinition, models, initialise, sync, reset, … */ }
```

The gqlize package (`packages/gqlize/src/index.ts`) exports the GraphQL layer:

```ts
export const createSchema = create;   // from ./graphql/index — accepts an Ormize instance
```

The Sequelize adapter's public API is its default-export class `SequelizeAdapter`, exported from `@azerothian/ormize-adapter-sequelize`.

### Consumer lifecycle

Canonical flow:

```ts
import { Ormize } from "@azerothian/ormize";
import { createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

// 1. Create the backend manager
const db = new Ormize();

// 2. Register one or more data-source adapters (the first becomes the default)
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");

// 3. Register model definitions (optionally per adapter)
db.addDefinition(TaskDefinition);
db.addDefinition(ItemDefinition);

// 4. Wire relationships across adapters, then bring adapters online
await db.initialise();
await db.sync();

// 5. Build the GraphQL schema (gqlize wraps the ormize instance)
const schema = await createSchema(db, options /* GqlizeOptions */);
```

Backend-only CRUD is available without building a schema: `await db.models.Task.create({ name: "alpha" })`.

The resulting `schema` is a standard `graphql` `GraphQLSchema` and is executed with the
stock `graphql()` executor. A `schema.$sql2gql = { types }` property is attached for
introspection of the generated types.

### Schema artifacts (`@azerothian/gqlize/snapshot`)

Step 5 can be split in two: build the schema once ahead of time, and rebuild an executable schema
from the artifact at boot. The subpath `@azerothian/gqlize/snapshot` exports the whole surface —
the `gqlize` CLI is a front-end over these and adds nothing a caller cannot do directly.

```ts
snapshotSchema(schema: GraphQLSchema, opts?: SnapshotOptions): SchemaSnapshot;
materializeSchema(snapshot, orm, options?): Promise<GraphQLSchema>;
loadSchema(artifactPath, orm, options?): Promise<GraphQLSchema>;   // read + parse + materialize
readSnapshot(artifactPath): Promise<SchemaSnapshot>;               // read + parse only
fingerprintDefinitions(orm, opts?): Fingerprint;
compareFingerprints(a, b): string[];                               // names of the differing parts
createScalarRegistry(extra?): ScalarRegistry;
SNAPSHOT_FORMAT_VERSION: number;

interface SnapshotOptions {
  scalars?: Record<string, GraphQLScalarType>;
  permissionProfile?: string;
}
interface MaterializeOptions extends SnapshotOptions {
  onMismatch?: "throw" | "warn" | "rebuild";        // default "throw"
  extendFactory?: (types: Record<string, GraphQLNamedType>) =>
    { query?: GraphQLFieldConfigMap<any, any>; mutation?: GraphQLFieldConfigMap<any, any> };
}
```

The lifecycle becomes: steps 1–4 unchanged (**the ormize instance is still mandatory** — it is the
resolution engine the materialized schema binds to; the artifact replaces only type construction),
then either `createSchema(db, options)` as above or `loadSchema(path, db, options)`.

Two contracts are easy to get wrong and are therefore enforced rather than documented alone:

- **Custom scalars must be passed at both ends.** Coercion is code and cannot be serialised, so the
  same `scalars` map goes to `snapshotSchema` and `materializeSchema`. Omitting it at load throws
  naming the scalar, rather than failing at request time.
- **`options.extend` and `options.root` are never serialised.** They are arbitrary user field
  configs with arbitrary resolvers; pass them at load exactly as you pass them to `createSchema`.
  `ledger.extendFields` records which keys survived the build-time permission gate. When an extend
  field must reference a *generated* type, use `extendFactory(types)` so it binds to the
  materialized instance rather than a stale one.

An artifact records only the model types its schema actually publishes. A permission bag that
denies both a model's query list field and its mutation entry leaves nothing in the schema
referring to that model, so the artifact carries no type for it and `ledger.modelTypes` does not
name it either — a restricted profile's artifact holds no trace of the models it hides. Relay
`node(id:)` is unaffected: it re-checks `permission.query` per request, and a model reachable
from nothing is one that predicate already denied.

Staleness is detected by `fingerprintDefinitions`, which hashes models, fields, relationships,
class methods, adapters, and the gqlize/graphql versions. It deliberately **excludes** the SQL
dialect — building against sqlite in CI and serving postgres in production is a supported setup and
does not change schema shape. It structurally **cannot** cover `options.permission`, which is a bag
of closures; `permissionProfile` is an opaque stand-in id, and `gqlize check` (strict by default)
closes the gap by rebuilding live and diffing the sorted SDL.

### Key `Ormize` (`GQLManager`) methods

Consumer-facing (`packages/ormize/src/manager.ts`):

- `registerAdapter(adapter, overrideName?)` — register an adapter; first one becomes `defaultAdapter`.
  The adapter must carry an `adapterName`, or the call must pass `overrideName`; a nameless adapter throws
  here rather than landing under the key `"undefined"` and leaving `defaultAdapter` unset, which used to
  surface as the *next* `addDefinition` blaming the definition for a name the adapter never supplied.
- `addDefinition(def, adapterName?)` — register a model definition (validates a unique `name`, wires the hook map, calls `adapter.createModel`).
- `initialise()` — process all relationships, then validate every cross-adapter relationship's key columns,
  then `initialise()` every adapter. The key check is a post-pass rather than part of wiring because a column
  need not exist yet when the relationship naming it is processed: relationships are wired concurrently, and a
  same-adapter association creates its foreign key as a side effect. A cross-adapter `foreignKey` / `sourceKey` /
  `targetKey` / `otherKey` naming a field that does not exist throws here — ormize reads such a column itself and
  cannot create it, so it must be declared in `define` by hand. See
  [guide §11](guide.md#11-multiple-data-sources).
- `sync(options?)` / `reset(options?)` — delegate to adapters.
- Hook registration: `addHook`, `addHookObject`, `unshiftHook`, `unshiftHookObject`, `createHook`.
- Introspection: `getModel(s)`, `getDefinition(s)`, `hasDefinition`, `getFields`, `getAssociations`, `getGlobalKeys`.

Internal resolution methods invoked by generated resolvers:

- `resolveFindAll` — list query resolver (cursor→offset, `adapter.processListArgsToOptions` → `adapter.findAll` + count, fires `before` with `Events.QUERY`).
- `resolveSingleRelationship` / `resolveManyRelationship` — relationship resolvers.
- `resolveClassMethod` — invokes `Model[methodName](args, context)` with optional before/after.
- `processCreate` / `processUpdate` / `processDelete` — mutation executors; run `processInputs`, translate global IDs (`replaceIdDeep`), fire the matching `Events.MUTATION_*` hook, delegate to adapter functions, then `processRelationshipMutation`.
- `processRelationshipMutation` — the nested-mutation engine (see §5).

> These internal resolution methods are invoked by gqlize's generated resolvers; they live in
> `packages/ormize/src/manager.ts` (the `Ormize` class is backend-only) and are called from the
> GraphQL layer in `packages/gqlize`.

---

## 4. Model Definition Schema

A **Definition** is the plain object passed to `db.addDefinition`. The full type lives in
`packages/utilize/src/types/index.ts` (`Definition`). The canonical, full-featured
example is `packages/gqlize/__tests__/helper/models/task.ts`.

### Fields

| Key | Purpose |
| --- | --- |
| `name` | Unique model name (required). |
| `datasource` | Optional adapter name; defaults to the manager's default adapter. |
| `define` | Field map. Each value is a `DefinitionField`: `type`, `allowNull`, `primaryKey`, `foreignKey`, `unique`, `defaultValue`, `values` (enum), `validate`, `description`, `comment`, plus `args` and `resolve` (per-field GraphQL arguments and a field resolver — see [guide: Field arguments & field resolvers](guide.md#field-arguments--field-resolvers)), `writable` (opt a pk/fk back into mutation input) and `ignoreGlobalKey`. |
| `override` | Per-field custom GraphQL type plus `input`/`output` transform functions (e.g. storing JSON in a string column but exposing a typed object). |
| `ignoreFields` | Columns to exclude from the generated type. |
| `relationships` | Array of `Relationship`: `{ model, name, type, options }` where `type ∈ hasOne | belongsTo | hasMany | belongsToMany` and `options` carries `as`, `foreignKey`, `sourceKey`, `through`, `constraints`. `name`, a known `type` and a `model` naming an already-defined target are all validated at wiring time, before either the same-adapter or cross-adapter branch runs, and each throws naming the relationship. Cross-adapter key columns are re-checked in a post-pass at the end of `initialise()` (see §3). |
| `whereOperators` / `whereOperatorTypes` | Custom filter operators (async functions returning a where fragment) and their GraphQL input types. |
| `expose` | Declares which methods surface to GraphQL: `expose.classMethods.{query,mutations}` and `expose.instanceMethods.{query,mutations}`, each an `ExposedMethod`: `{ type?, args?, before?, after?, fields?, include?, input?, output?, orderBy?, where? }`. `type` may be a string model reference (`"Task"`) or a list (`"Task[]"`), or a concrete GraphQL type. See [Exposed methods](#exposed-methods). |
| `classMethods` / `instanceMethods` | The implementations behind `expose` (in the Sequelize adapter these are placed under `options.classMethods` / `options.instanceMethods`). |
| `before` / `after` | gqlize-level transforms discriminated by the `Events` enum (see §8). |
| `hooks` | Sequelize-style lifecycle `HookMap`. |
| `options` | Adapter-specific options passed through to the data source (Sequelize: `tableName`, `paranoid`, `indexes`, `hooks`, …). Also `autoInclude: false` to opt this model out of root-level eager resolution (see §5). |

### Example (trimmed from `task.ts`)

```ts
export default {
  name: "Task",
  define: {
    name: {
      type: Sequelize.STRING,
      allowNull: false,
      validate: { isAlphanumeric: { msg: "letters and numbers only" } },
    },
    options: { type: Sequelize.STRING, allowNull: true }, // stored as JSON string
  },
  // Transform mutation input by event type
  before(req) {
    if (req.type === events.MUTATION_CREATE) {
      return { ...req.params, mutationCheck: "create" };
    }
    return req.params;
  },
  after(req) { return req.result; },
  // Expose a JSON string column as a typed GraphQL object
  override: {
    options: {
      type: { name: "TaskOptions", fields: { hidden: { type: GraphQLString } } },
      output: (result) => JSON.parse(result.get("options")),
      input:  (field)  => JSON.stringify(field),
    },
  },
  relationships: [
    { type: "hasMany",       model: "TaskItem", name: "items",    options: { foreignKey: "taskId" } },
    { type: "hasOne",        model: "Item",     name: "item",     options: { foreignKey: "taskId" } },
    { type: "belongsToMany", model: "Item",     name: "btmItems", options: { through: "btm-tasks", foreignKey: "taskId" } },
  ],
  // Custom filter operator usable in `where`
  whereOperators: {
    async hasNoItems() {
      return { id: { [Op.notIn]: Sequelize.literal(`(SELECT DISTINCT("taskId") FROM "task-items")`) } };
    },
  },
  whereOperatorTypes: { hasNoItems: GraphQLBoolean },
  // Surface methods to GraphQL
  expose: {
    classMethods: {
      query:     { getHiddenData: { type: /* GraphQLObjectType */, args: {} } },
      mutations: { reverseName:   { type: "Task", args: { input: /* ... */ } } },
    },
  },
  options: {
    tableName: "tasks",
    classMethods: { async getHiddenData() { return { hidden: "Hi" }; } },
  },
} as Definition;
```

### Exposed methods

An entry under `expose` is an `ExposedMethod` (`packages/utilize/src/types/index.ts`). Beyond
the schema shape (`type`, `args`) and the hooks (`before`, `after`) every target understands,
an entry may declare what the method *needs loaded* and how it *shapes the query it is selected
in*. Those keys are read by `packages/utilize/src/exposed-methods.ts` — GraphQL-free, so
gqlize, ormize and every adapter agree on what a declaration means:

| Key | Shape | Read by | Effect |
| --- | --- | --- | --- |
| `fields` | `string[]` \| `"*"` | `methodProjection` | Columns unioned into the projection when the method is selected. `"*"` drops narrowing for that query. |
| `include` | `DeclaredIncludeMap` (`{ [relName]: Partial<IncludeDescriptor> }`) | `methodProjection` | Relations merged into the include plan. `target`/`associationType` are filled from the live association by `normalizeDeclaredInclude` (`packages/gqlize/src/manager.ts`). |
| `input` | `(params, ctx) => params` | `methodOptionHooks` | Carried on `Selection.optionHooks` and run against the built query options. |
| `output` | `(value, ctx) => any` | `create-complex-fields.ts` | Produces the field value; makes the implementation optional. |
| `orderBy` | `string[]` \| `(direction, ctx) => OrderEntry[]` | `computedOrderableFields`, `expandOrderBy` | Contributes `<name>ASC`/`<name>DESC` to the model's orderBy enum; expanded to real ordering at query time. |
| `where` | `string` \| `{ type?, operators?, resolve }` | `computedWhereFields`, `computedWhereOperators`, `whereOperatorsFor` | Contributes a nested operator object to the model's `where`, resolved as a custom where-operator. `type` is the GraphQL input type the operators take and defaults to `GraphQLString`; the `string` form names a real column and borrows its type instead. |

Rules the surface holds to:

- **Push-down only.** `orderBy` and `where` must yield query fragments. Nothing is sorted or
  filtered in memory afterwards: post-filtering would break `first`/`last` and cursor offsets
  and desync `total`, and fetch-all-then-filter is a DoS vector on exactly the models that
  invite it.
- **Permission-gated contributions.** `computedOrderableFields` and `computedWhereFields` both
  filter through `permission.queryInstanceMethods` — sortability and filterability each leak a
  denied field's value.
  The portable `where: "column"` form carries a second gate: it is dropped outright when the
  borrowed column is not itself filterable — denied by permissions, or simply not filterable on
  that backend — rather than falling back to a default type, so a denied column cannot be
  reached through a computed alias (`packages/graphql-types/src/adapter-args.ts`).
- **Declared `fields` are server-side.** They load columns the client's selection set could
  never reach. The definition author wrote both sides, so it is their call; it is documented
  rather than discovered.
- **Ordering.** `fields`/`include` merge into the projection first, then `definition.before`,
  then each selected method's `input` in declaration order — `input` sees the final options and
  gets the last word. `output` then produces the value and `after` post-hooks it.
- **Aliases.** The same method selected twice with different args runs `input` once per
  selection occurrence and `output` once per row per occurrence.
- **Collisions.** `assertNoExposedMethodCollisions`, called from `create-model-type.ts` (the one
  point that sees both the model's columns and its `expose` block), throws when an exposed
  instance method's name is a column, or when a name appears in both `instanceMethods.query` and
  `instanceMethods.mutations` — both targets resolve to the same implementation namespace.
- **No schema-shape change.** `exposeProjection` (`packages/gqlize/src/graphql/snapshot/fingerprint.ts`)
  is unchanged by these keys, so existing schema snapshots stay valid.

`expose.instanceMethods.mutations` is the write-side target: pre-commit transforms, surfaced as
the mutation's `apply` argument (§5) and run by `applyInstanceTransforms`
(`packages/ormize/src/manager.ts`) after `definition.before` and immediately before the adapter
persists. On create the transform's `this` is the pending values object; on update it is the
live row, wrapped in a recording proxy so direct writes (`this.name = …`) are captured and
persisted alongside a returned partial — the Sequelize adapter's update path persists the values
map, not the row's own mutations. Transforms run **inside the mutation's transaction**, so a
throw rolls the whole mutation back, nested relationship writes included; they must not reach
outside it. Gated by `permission.mutationInstanceMethods`.

### Typed definitions (opt-in typesystem)

By default `Ormize.models` is `{ [name: string]: any }`. An opt-in, type-level system makes
`db.models.<Name>` a fully-typed model — instance attributes + `classMethods` statics — without
changing runtime behaviour. It is layered to keep the **core adapter-agnostic**:

| Layer | Location | Provides |
| --- | --- | --- |
| Generic plumbing | `utilize/src/types/orm.ts` | `ITypedDefinition<Name, Instance, Statics>`, `AnyTypedDef`, `ModelNameOf`, the generic **`IORModel<TBase, Required, Optional>`**, and the `IORBaseRegistry` HKT registry (fp-ts URI pattern). No `sequelize`. |
| Sequelize binding | `ormize-adapter-sequelize/src/types/orm.ts` | `defineModel<TInstance, TStatics>()`, the `"sequelize"` `IORBaseRegistry` augmentation → `ModelStatic<…>`, `IORSequelizeModel`, `SequelizeModel<Req, Opt>`, and the adapter's `__base` brand. The only sequelize-coupled file. |
| Manager | `ormize/src/manager.ts` | `GQLManager<TModels, TBase>` / `Ormize` (both defaulted for backward compat), the fluent synchronous `define()` (applies `IORModel<TBase, [D], []>`; models created in `initialise()`), and `registerAdapter` threading `TBase` from the adapter's `__base` brand. Imports **no** sequelize or graphql. |

Authors declare the instance interface the standard Sequelize v6 way
(`Model<InferAttributes<M>, InferCreationAttributes<M>>`) and register with
`new Ormize().registerAdapter(adapter).define(defineModel<TInstance, TStatics>(def))`.
`IORModel` composes fragments with **required** (required members) and **optional** (`?` members)
buckets. Type-level parity (including optionality, which needs `strictNullChecks`) is verified by
`ormize-adapter-sequelize/__tests__/types/orm.test-d.ts` under
`tsconfig.test-d.json` (`pnpm typecheck:types`); runtime integration by
`__tests__/define-model.test.ts`. Note: `DataType → TS` inference is intentionally **not**
attempted — Sequelize v6 types `UUID`/`JSON`/`BOOLEAN`/… as one indistinct
`AbstractDataTypeConstructor`, so attribute types are author-declared.

---

## 5. Generated Schema Shape

Schema construction is orchestrated by `createSchemaObjects` in
`packages/gqlize/src/graphql/index.ts`, iterating `instance.getDefinitions()` through
`waterfall` reducers into a shared `SchemaCache`
(`packages/gqlize/src/graphql/create-schema-cache.ts`), in dependency order: model types →
list objects → class-method queries → mutation inputs → mutation models → class-method
mutations.

### Root query

| Field | Meaning |
| --- | --- |
| `node` | Relay node lookup by global ID. |
| `models` | `QueryModels` object; one Relay connection field per model (`edges { node } pageInfo total`). |
| `classMethods` | Per-model exposed **query** class methods. |

Extra query fields may be injected via `options.extend.query`.

### Root mutation

| Field | Meaning |
| --- | --- |
| `models` | Per-model `create` / `update` / `delete` operations, each supporting **nested relationship mutations**. |
| `classMethods` | Per-model exposed **mutation** class methods (`MutationClassMethods`). |

Extra mutation fields may be injected via `options.extend.mutation`. Subscriptions are not
generated: `options.subscriptions` is accepted and ignored (the generator is commented out —
§13), so a subscription root has to be hand-written and merged in through `options.root`.

### Field builders (per model type)

`create-model-type.ts` merges three lazily-cached builders:

- `create-basic-fields.ts` — scalar/column fields. Primary and foreign keys become Relay
  **global-id** fields; other columns go through the adapter's type mapper. Honors
  `ignoreFields`, `override`, and the `permission.field` gate. If an `id` field exists the
  type implements the Relay `nodeInterface`.
- `create-related-fields.ts` — associations. `belongsTo`/`hasOne` → single-object fields via
  `resolveSingleRelationship`; `hasMany`/`belongsToMany` → nested Relay connections via
  `resolveManyRelationship`. Gated by `permission.relationship`.
- `create-complex-fields.ts` — exposed instance-method query fields. Gated by
  `permission.queryInstanceMethods`. A field's `output` (if declared) produces the value,
  otherwise the `definition.instanceMethods` implementation is invoked with `this` bound to the
  row; `after` post-hooks either. The builder also records the selection so the method's
  `fields`/`include`/`input` declarations reach the query (see
  [Query resolution & eager loading](#query-resolution--eager-loading)).

### Mutation inputs & deep writes

`create-mutation-input.ts` generates `{Def}RequiredInput` (create), `{Def}OptionalInput`
(update), `{Def}UpdateInput` / `{Def}SelectInput` (`where`/`limit`/`input`), and delete filter
inputs. The top-level model mutation exposes `create` / `update` / `delete` / **`select`**, plus
**`apply`** (`create-mutation-model.ts`) when the model exposes instance-method transforms — an
input object with one field per `expose.instanceMethods.mutations` entry, typed by that entry's
`args` (or `Boolean` when it declares none), gated by `permission.mutationInstanceMethods`. For each
association it also emits nested sub-fields, enabling deep writes, applied by
`processRelationshipMutation` (`packages/ormize/src/manager.ts`) via the Sequelize association
accessors (recursion depends on the graphql patch, see §12). The sub-fields per association type:

- **hasMany / belongsToMany:** `create` (new records), `update` (`where`+`input` pairs),
  `add` (associate existing by where), `set` (replace the entire set with matching existing
  records), `remove` (disassociate matching), `delete` (delete matching), `restore` (undelete
  soft-deleted matching, paranoid models). For **belongsToMany**, `add`/`set` entries are
  `{ where, through }` where `through` (a JSON payload) writes join-table column values.
- **belongsTo / hasOne:** `create`, `update`, `set` (associate an existing record found by a
  where filter → `accessors.set`), `remove` (`Boolean` → disassociate via `set(null)`),
  `delete`, `restore`.

**`select`** (top-level and every relationship, entries `{ where, input }`) finds existing records
by filter and runs **further relationship mutations** on them via `input` **without modifying the
found records** — no field write, no create/update/delete; scalar fields in `input` are ignored.
Nested `select` is **relationship-scoped** (`source[accessors.get]({ where })`, firing
`beforeFind`/`afterFind`); top-level `select` finds globally (`adapter.findAll`) and returns the
found rows. Implemented by `processSelect` (top-level) and the `select` branch of
`processRelationshipMutation` (`manager.ts`), which recurse without calling
`processCreate`/`processUpdate`/`processDelete` on the selected rows.

### Example query

```graphql
query {
  models {
    Task {
      edges {
        node {
          id
          name
          items { edges { node { id } } }
        }
      }
    }
  }
}
```

### Example mutation

```graphql
mutation {
  models {
    Task(update: {
      where: { name: "start" },
      input: { items: { remove: { name: { in: ["item000002", "item000003"] } } } }
    }) {
      id
      items { edges { node { id name } } }
    }
  }
}
```

### Query resolution & eager loading

For a top-level list query, `resolveFindAll` (`packages/ormize/src/manager.ts`) resolves the
requested relationships **at the root level** rather than lazily per parent. It builds a
combined include tree from the GraphQL **selection set** — merged with any explicit `include`
argument — via `packages/gqlize/src/graphql/utils/build-include-from-selection.ts`, then issues
the query through the adapter. Key properties:

- **Selection-driven, not `include`-driven.** The include tree is derived from which
  relationships are actually selected (and their per-field args: `where`, `orderBy`, `first`,
  `last`, `after`, `before`, nested `include`). It does **not** require an `include` argument to
  be supplied. Inline fragments (`... on Type`) and named fragment spreads (`...Frag`) are
  expanded, so fragment-selected relationships are eager-loaded too.
- **Merge, not override.** The selection-derived tree and any explicit `include` args (parent
  level and nested) are merged by relation name and path (`where` → AND, `required` → OR,
  orderBy/pagination precedence) — a parent `include` and a nested `include` for the same
  section combine rather than clobber each other.
- **Adapter-aware.** Only relationships whose target is on the **same adapter** as the parent
  are folded into the parent query. Cross-adapter relationships (a different adapter — no shared
  database to JOIN) are left to their own resolvers, which run them as separate root queries.
- **Same-adapter strategy (Sequelize adapter, `processIncludeStatement`):**
  - **JOIN by default** — `belongsTo` / `hasOne` / `belongsToMany`, and `hasMany` without
    pagination, fold into the parent query as a JOIN (a single SQL statement). Because
    Sequelize does not fire a JOIN-included model's find hooks, gqlize fires them manually:
    `beforeFind` at include-build time (scoped to that relation's `where`, merged back into the
    combined query) and `afterFind` after the parent query.
  - **`separate: true` only when necessary** — a `hasMany` uses a batched root-level child
    query (`WHERE fk IN (parentIds)`) only when it carries per-parent pagination
    (`first`/`last`/`after`/`before`), which a JOIN cannot express, or when explicitly requested
    via a `separate: true` field on the `include` argument. On this path the child's find hooks
    (and count) fire natively.
  - A `required` include always stays an INNER JOIN (it filters parent rows, which a separate
    query cannot do) — `required` wins over `separate`.
- **`required` argument.** Relationship fields accept an optional `required: Boolean` argument
  (e.g. `items(required: true, where: {…})` or the single-valued `item(required: true)`). By
  default a selected relation is a LEFT JOIN, so a nested `where` filters the child rows but not
  the parent; `required: true` promotes it to an INNER JOIN so parents without a matching related
  row are excluded. Equivalent to `required` on the explicit `include` argument (the two
  OR-merge).
- **Accurate totals.** When a per-parent limit is applied, the nested connection's `total` is
  fetched with a `count` (firing `beforeCount`) rather than reported as the page length. hasMany
  counts run against the target model with the foreign-key filter so `beforeCount` fires (the
  hasMany count accessor otherwise runs via `findAll`).
- **Count-only.** When a connection selects `total` but not `edges`/rows, the `findAll` is
  skipped and a `count` runs instead — firing `beforeCount` and the gqlize-level `afterCount`
  hook. See §8.
- **Exposed-method declarations.** A selected instance-method query field widens the query
  before it runs: its `fields` are unioned into the projection (or narrowing is dropped for
  `fields: "*"`) and its `include` merges into the include tree. Its `input` hook is carried on
  `Selection.optionHooks` and applied to the built options after `definition.before`, in
  declaration order. On a backend without an inline count, a hook that narrows the row set has
  its `where`/`include` copied onto the count options too, so `total` stays in sync. See
  [Exposed methods](#exposed-methods).
- **Opt-out.** Set `options.autoInclude = false` on a `Definition` to disable root-level eager
  resolution for that model and fall back to per-relation resolution.

This replaces the previous behaviour where an eager-loaded relation short-circuited the nested
resolver — dropping the nested field's arguments and skipping its find hooks. See also the hook
implications in §8.

---

## 6. Relay Connections & Global IDs

List and relationship fields use a **custom connection shape** built by
`create-list-object.ts`:

```
{ pageInfo, total, edges: [{ node, cursor }] }
```

with cursor args `after`, `first`, `before`, `last`, `orderBy`, merged with the adapter's
default list args (`where` filter + `include`). Cursors are index-based and carry the name of
the connection that minted them, so a cursor is rejected by any other connection, whose index
would mean something else entirely. This differs from stock `graphql-relay` connections in that
each connection carries a `total` count — backed on supported dialects by an inline
`COUNT(*) OVER()` (`hasInlineCountFeature` / `getInlineCount`) to avoid a second query.

Primary-key and foreign-key fields are exposed as **global IDs**, carrying the type alongside
the raw key. Global IDs are translated back to raw IDs across both queries and mutations by
`replaceIdDeep` (`packages/gqlize/src/utils/replace-id-deep.ts`, re-exported to both adapters),
which decodes a key **against the type that key points at** — a model's own name for a primary
key, the relationship's `foreignTarget` for a foreign key (`globalKeyTargets`,
`packages/utilize/src/utils/global-keys.ts`). A global ID minted for another type does not
decode, and the undecoded value then matches nothing rather than filtering on the raw key
underneath it. A shared node interface and type mapper resolve a global ID back to its concrete
object type.

### Codecs

Neither format is fixed. Both are supplied by a codec on `GqlizeOptions`, and both defaults are
byte-for-byte what earlier versions emitted:

- `options.id` — an `IdCodec` (`packages/gqlize/src/codecs/id.ts`), defaulting to
  `relayIdCodec()`: `graphql-relay`'s base64 `Type:id`. Also shipped are `prefixIdCodec` and
  `rawIdCodec`.
- `options.cursor` — a `CursorCodec` (`packages/gqlize/src/codecs/cursor.ts`), defaulting to
  `relayCursorCodec()`: base64 `["Connection", index]`. Also shipped are `plainCursorCodec`,
  `signedCursorCodec` (HMAC over the index) and `fallbackCursorCodec(next, ...previous)`, which
  mints in the first format and reads any of them — the rolling-deploy path.

The interfaces are declared in `packages/utilize/src/types/index.ts`, which stays graphql-free;
the implementations live in gqlize because `relayIdCodec` delegates to `graphql-relay`. `decode`
returns `null` for a value the codec does not recognise and never throws: one caller turns that
`null` into `GraphQLError("Invalid cursor")` and another — the nested-relation offset planner —
plans no offset, and a codec should not have to know which one it is inside.

An `IdCodec` declaring `carriesType: false` cannot recover a type from an ID, so the root
`node(id:)` field is omitted from the schema at build time with a warning rather than left in it
to return `null` for every lookup.

Codecs are closures and cannot be hashed, so the snapshot fingerprint records whether each was
configured (`optionsShape`) plus an optional opaque `idProfile` / `cursorProfile` — the same
arrangement as `permissionProfile`, and for the same reason: an artifact built with codecs and
served without them resolves perfectly well, in the wrong format. See §5 and
`graphql/snapshot/fingerprint.ts`.

---

## 7. Permissions

Permissions are configured via `options.permission` (type `GqlizeOptions.permission` in
`packages/utilize/src/types/index.ts`). All but one are **build-time** callbacks, consulted
throughout `packages/gqlize/src/graphql/*`: each returns a boolean, and returning falsy omits the
corresponding schema element. `scope` is the exception on both counts — it returns a filter rather
than a decision, and it is consulted per request rather than per schema.

| Callback | Gates |
| --- | --- |
| `model(defName, options)` | Whether the model type is generated at all. |
| `query(defName, options)` | The list query for a model. |
| `mutation` / `mutationCreate` / `mutationUpdate` / `mutationDelete` | Mutation operations. |
| `mutationCreateInput` / `mutationUpdateInput` (defName, fieldName, options) | Individual input fields. |
| `field(defName, fieldName, options)` | Individual output fields. |
| `relationship(defName, relName, targetName, options)` | Relationship fields. |
| `queryClassMethods` / `mutationClassMethods` | Exposed class methods. |
| `queryInstanceMethods` | Exposed instance-method query fields — and, with them, the `orderBy` enum values and `where` fields those methods contribute (sortability and filterability each leak a denied field's value). |
| `mutationInstanceMethods` | Exposed instance-method transforms, i.e. the fields of a mutation's `apply` argument. |
| `queryExtension` / `mutationExtension` (fieldName, options) | `options.extend.*` fields. The first argument is the extend field key, not a model name. |
| `scope(defName, operation, options, context)` | **Resolution-time.** Which *rows* an operation may read or write — see below. |

A shared `options.permission.options` value is threaded into every callback.

This table is the whole set. `PERMISSION_KEYS` in `packages/utilize/src/gate.ts` is the
machine-readable copy, and `createSchemaObjects` warns when a bag carries a key outside it —
worth flagging because an absent predicate means *allow*, so an unread key fails open. There
is no `subscription` callback while subscriptions remain unimplemented (§13).

### Build-time and resolution-time keys

`PERMISSION_KEYS` is the union of two disjoint lists in the same file:
`BUILD_TIME_PERMISSION_KEYS`, which is every row above bar the last plus the shared `options`
value, and `RESOLUTION_TIME_PERMISSION_KEYS`, which is `["scope"]`. The split is structural rather
than conventional: a test walks `packages/gqlize/src/graphql/*` and fails if anything there reads a
resolution-time key. That is what makes `scope`'s `async` signature safe — a predicate that may
return a `Promise` is unusable from a synchronous schema build, so the boundary has to hold.

`scope` also inverts two of the rules the table above states. Its return value is
`undefined | false | PortableWhere | {where, set, native}`, in which `undefined` is "no opinion"
(**no** restriction) and `false` is a deny — so it must never pass through `isAllowed`, whose `!!`
would coerce a returned filter to `true` and drop the restriction entirely. And `defaultDeny` does
not reach it in the role-based helper: an absent `scope` means unscoped, because the key postdates
every deployment that does not set one.

Enforcement is deliberately layered (issue #40 decision 8). The engine merges the resolved filter at
its read and write chokepoints in `packages/ormize/src/manager.ts`; on sequelize a second copy is
imposed by model hooks in `packages/ormize/src/scope-hooks.ts`, which sit below the paths the engine
cannot see; a post-write re-check refuses a write that would move a row out of scope; and an
instance-level `beforeQuery` refuses a raw statement bound to a scoped model that did not come
through the scope-aware path. Surfaces holding the model directly — class methods, instance methods,
`options.extend` fields, raw-SQL class methods — have no filter to merge into, so
`packages/ormize/src/scope-audit.ts` refuses to build one that has not declared itself
`scopeAware` or `unscoped` (a raw statement declares itself by reserving a `:scope…` parameter).
`{native: …}` is merged in the adapter's own vocabulary instead of the portable one and is
adapter-locking by construction.

A write the scope denies outright reports nothing by default, indistinguishably from a write that
matched no row; `GqlizeOptions.onScopeMiss: "throw"` trades that for a loud refusal, at the cost of
confirming the scoped-out row exists. See `docs/guide.md` §8 for the configuration surface, including
the residual inference channels a row filter cannot close.

### Role-based helper

`packages/utilize/src/permissions.ts` provides
`createRoleBasedPermissions(role, rules, options)`, which compiles an allow/deny rules tree
(merged with defaults via `deepmerge`, honoring `defaultDeny` and `allow`/`deny` leaves)
into the `permission` object above — so consumers can declare permissions per role rather
than writing every callback by hand. It emits only callbacks from the table above; a rules
key nothing reads is warned about rather than silently compiled into a dead predicate.

`scope` has its own compiler in that file rather than going through `decideKey`, for the two
reasons the split above describes: its leaves are values (`{own: "ownerId"}`) rather than
`allow`/`deny`, which `decideKey` would read as "no opinion", and its second level is an
*operation* rather than a field name. It supports `own` / `tenant` / `group` / `none` leaves, `any`
and `all` combinators, and a `read` / `write` split with per-operation override; the principal is
read from the request context by a `principal` option defaulting to
`context.user` / `context.principal` / `context.req.user`. A reader that finds nothing is a deny, as
is a `group` leaf whose principal belongs to no groups.

Two rules keys feed more than one callback: `extensions` is accepted as a synonym for both
`queryExtension` and `mutationExtension`, and `mutationCreateInput` / `mutationUpdateInput`
fall back to `field` when unspecified, so a role that can read a field can also write it.
The more specific key wins wherever both express an opinion.

---

## 8. Lifecycle Hooks & Events

gqlize has two distinct hook systems.

### 1. Sequelize-style lifecycle hooks

The manager recognizes Sequelize's lifecycle hook names, split across two lists in
`packages/ormize/src/manager.ts` by where the hook actually fires.

**Model hooks** (`hookList`) are registered on the model: `beforeValidate`/`afterValidate`,
`validationFailed`, `beforeCreate`/`afterCreate`, `beforeUpdate`/`afterUpdate`,
`beforeDestroy`/`afterDestroy`, `beforeSave`/`afterSave`, `beforeFind`/`afterFind`,
`beforeCount`, `beforeBulk*`, `beforeAssociate`/`afterAssociate`, `beforeSync`/`afterSync`,
and more. They may be registered globally (`options.globalHooks`) or per-definition
(`def.hooks` / `def.options.hooks`). `createHook` composes per-definition hooks followed by
global hooks into a `waterfall` pipeline, so each hook receives the previous hook's return
value. A hook may be a single function or an array of functions.

**Sequelize-instance hooks** (`sequelizeHookList`) fire off the Sequelize object rather than
any model: `beforeDefine`/`afterDefine`, `beforeInit`/`afterInit`,
`beforeConnect`/`afterConnect`, `beforeBulkSync`/`afterBulkSync`, and
`beforeQuery`/`afterQuery`. These are **global only** — there is no model to scope them to, so
there is no per-definition form, and a `def.hooks.beforeQuery` is refused with a warning rather
than registered somewhere it would never run. Register them with `options.globalHooks` or
`db.addHook(name, fn)`; ormize installs them on the connection once per adapter during
`initialise()` (`OrmAdapter.installInstanceHooks`). Unlike model hooks they are handed
Sequelize's own arguments unchanged and are **not** waterfalled — Sequelize discards what a
hook returns, so an instance hook works by mutating the `options` object it is given. Note that
`beforeQuery` runs before the statement is handed to the driver, so `query.sql` is not
populated yet: it can inspect `options` and throw, but it cannot rewrite the SQL.

### 2. gqlize-level `before` / `after`

A Definition may declare `before` and `after` transforms invoked around queries and
mutations. They receive a request object:

```ts
before({ params, args, context, info, model, modelDefinition, type });
after({ result,  args, context, info,        modelDefinition, type });
```

`before` transforms mutation inputs / query options; `after` transforms outputs (see
`packages/gqlize/src/graphql/utils/after.ts`). The `type` field is an `Events` enum value.

### The `Events` enum

Defined in `packages/utilize/src/events.ts`:

| Value | Name |
| --- | --- |
| `1` | `QUERY` |
| `2` | `MUTATION_CREATE` |
| `3` | `MUTATION_UPDATE` |
| `4` | `MUTATION_DELETE` |
| `5` | `OUTPUT` |

### Hooks under root-level eager loading

Because relationships are resolved at the root level (§5), a child model's find hooks fire
regardless of how it is loaded:

- **JOIN-loaded** relations (`belongsTo`/`hasOne`/`belongsToMany`, and non-paginated `hasMany`)
  are fetched within the parent query, where Sequelize does not fire the child's find hooks, so
  gqlize fires them **manually** — `beforeFind` at include-build time (scoped to the relation's
  `where`, merged back into the combined query, so a filtering `beforeFind` excludes rows in the
  single query) and `afterFind` after the parent query.
- **`separate: true`** (paginated `hasMany`) and **cross-adapter** relations execute their own
  child `findAll`, so `beforeFind`/`afterFind`/`beforeCount` fire **natively**. Guards ensure a
  hook fires exactly once (no manual + native double-firing).

`afterCount` is a **gqlize-level** hook (Sequelize has none): it is composed into the
per-definition hook map so `runHook` can fire it after a count, but it is withheld from
`sequelize.define` (an unknown native hook name would throw). It fires on the count-only path
(§5) and can transform the reported `total`.

---

## 9. Adapter Contract

Any data source is integrated by implementing the `GqlizeAdapter` interface
(`packages/utilize/src/types/index.ts`). The Sequelize adapter
(`packages/ormize-adapter-sequelize/src/index.ts`) is the reference implementation. The
contract groups into:

- **Lifecycle:** `createModel`, `initialise`, `sync`, `reset`.
- **Introspection:** `getModel`, `getFields` (→ `DefinitionField`), `getAssociations`
  (→ `Association`), `getPrimaryKeyNameForModel`, `getValueFromInstance`.
- **Type mapping:** `getTypeMapper`, `getDefaultListArgs`, `getOrderByGraphQLType`,
  `getFilterGraphQLType`. The host passed to these carries an optional
  `computedOrderableFields(defName, permission?)` so an adapter can fold exposed methods'
  `orderBy` declarations into the orderBy enum without knowing what an exposed method is.
- **Relationships:** `createRelationship`, `createFunctionForFind`,
  `resolveManyRelationship`, `resolveSingleRelationship`.
- **Querying:** `processListArgsToOptions`, `findAll`, `count`, `hasInlineCountFeature`,
  `getInlineCount`, `processFilterArgument`, `replaceIdInArgs`.
- **Mutations:** `getCreateFunction`, `getUpdateFunction`, `getDeleteFunction`, `update`.

### Sequelize adapter highlights

- `createModel` calls `sequelize.define(name, define, options)`, attaches class/instance
  methods (including SQL-generating class methods), and stashes the `definition` on the model.
- `getFields` reflects over `rawAttributes` to derive `primaryKey`, `allowNull`,
  `foreignKey`/`foreignTarget`, and `autoPopulated`, and carries through `description`
  (`description ?? comment`, matching the valkey adapter), `defaultValue`, `args`, `resolve`,
  `ignoreGlobalKey` and `writable`. The last four are meaningless to Sequelize and survive only
  because `define` passes unknown attribute keys onto `rawAttributes` untouched — undocumented
  behaviour, so `__tests__/define-model.test.ts` carries a canary for it. They are read back by
  name rather than by spreading `rawAttributes`, which also hangs a circular `Model`
  back-reference, internals such as `_modelAttribute`, and a `unique` normalised to a shape
  `DefinitionFieldMeta` does not describe — and `getFields` memoises, so all of it would be
  retained per field for the process's lifetime.
- Filtering: `createQueryType` (from `@azerothian/graphql-types`) builds the `where` input;
  `processFilterArgument` → `replaceWhereOperators` (`utils/where-ops.ts`) maps GraphQL
  operator names to Sequelize `Op.*`, and custom operators are resolved. Every read of a
  definition's operators on a query path goes through `whereOperatorsFor`, which folds the
  definition's own `whereOperators` together with the ones its exposed methods' `where`
  declarations imply — at include depth as well as at the root.
- `getOrderByGraphQLType` builds a `{Def}OrderBy` enum (`fieldASC` / `fieldDESC`), including
  the computed entries from `computedOrderableFields`, which `expandOrderBy` turns back into
  real column ordering at query time;
  `getIncludeGraphQLType` builds recursive nested-include input for eager-loaded joins.
- Inline count via `COUNT(*) OVER()` on postgres/mssql/sqlite.
- `type-mapper.ts` maps Sequelize DataTypes → GraphQL types.

---

## 10. Custom Scalars

`@azerothian/graphql-types` (`packages/graphql-types/src/index.ts`) provides custom scalars,
each with its own subpath export:

| Export | Subpath | Purpose |
| --- | --- | --- |
| `BigIntType` | `.../bigint` | 64-bit integers. |
| `DateType` | `.../date` | Date/time values. |
| `IPType` | `.../ip` | IP addresses. |
| `JSONType` | `.../json` | Arbitrary JSON. |
| `UploadType` | `.../upload` | File uploads. |
| `createQueryType`, `defaultConfig` | `.../query` | Builds the `where`/filter input type used by adapters. |

---

## 11. Build, Test & Tooling

- **Orchestration:** Turborepo + pnpm. Root scripts: `build` (`turbo run build`), `test`
  (`turbo run test`), `typecheck` (`tsc -b && turbo run typecheck`), `watch`.
- **Compilation:** **SWC** emits two module formats per package into a `publish/` dir —
  `import` → ESM (extensions fixed by each package's `scripts/fix-esm-extensions.ts`),
  `require` → CJS. Type declarations via `tsc`. A `bun` export condition serves the raw
  `.ts` source so Bun can run source directly. Each package's `scripts/prepare-package.ts`
  generates the per-file `exports` map and rewrites `workspace:*` ranges at publish time.
- **Tests:** **Jest** with `@swc/jest`. Each package's `jest.config.js` uses a
  `moduleNameMapper` that resolves sibling workspace packages to their `src/`, so tests run
  against source with no build step. Suites in `packages/*/__tests__/` cover queries,
  mutations, Relay connections, permissions, comments, the manager, per-builder units, and
  (in the adapter) Sequelize + filter behavior. Sample models: `Task`, `Item`, `TaskItem`,
  `Parent`, `Child`.
- **Jest projects (`packages/gqlize`):** `sqlite` (everything), `postgres` (a subset, against
  PGlite), and `roundtrip` — which re-runs the functional suites unmodified against a schema that
  has been built, snapshotted to JSON, and materialized back. It does that by remapping the exact
  specifier those suites import (`^\.\./src$`) to `__tests__/setup/roundtrip-src.ts`, whose
  `createSchema` performs the round trip. The anchored match leaves the per-builder unit tests,
  which import `../../src/graphql/create-*`, untouched. This project is the always-on gate against
  the live builder and the materializer drifting apart, and is expected to stay green in CI.
- **Typecheck:** two programs, both run by the root `typecheck` script and one CI step.
  `tsc -b` builds the composite `src` projects (each package's `tsconfig.json` is
  `include: ["src/**/*"]`, so it never sees a test file). `turbo run typecheck` then runs each
  package's `tsc -p tsconfig.test.json`, a `noEmit` program over `src` **and** `__tests__`.
  That second program matters because Jest compiles with `@swc/jest`, which strips types
  without checking them — without it a test could call a function with the wrong arity, or pass
  the wrong object, and nothing would ever say so. Notes on its shape:
  - `rootDir` is `../..`: `paths` resolves sibling packages to their **source**, so the program
    genuinely spans the workspace and needs no built declarations — every package's check runs
    in parallel with no `dependsOn`.
  - `types: ["node", "jest"]` is set explicitly because pnpm installs `@types/*` per package.
  - `ormize-adapter-sequelize` additionally runs `tsc -p tsconfig.test-d.json`, the `strict: true`
    program over `src/types` + `__tests__/types` that backs its `@ts-expect-error` assertions.
    `tsconfig.test.json` excludes `__tests__/types` there, since a file cannot satisfy
    `@ts-expect-error` under two different strictness settings at once.
- **Runtime:** Node.js ≥ 24.
- **Binary:** `@azerothian/gqlize` ships a `gqlize` command. `scripts/prepare-package.ts` sets
  `bin: { gqlize: "./cjs/cli/index.js" }` — the CJS build, because it runs on every supported Node
  without an `exports`/extension dance. SWC preserves the leading `#!/usr/bin/env node` verbatim, so
  no post-processing step is needed.
- **Publishing:** per-package `pnpm build` → `publish/` → `package:npm` / `package:yalc`.
- **CI:** `.github/workflows/` — `ci.yml`, plus `release.yml` and `release-announce.yml`
  (staged publishing to npmjs via OIDC trusted publishing).

---

## 12. The graphql Patch

`graphql@17.0.2` is a **pinned peer dependency**. gqlize requires a mutation's *nested*
sub-fields to execute serially, but stock graphql only serializes *top-level* mutation
fields — nested sub-fields run asynchronously. Because gqlize's deep relationship mutations
(create/update/delete/add/remove) rely on serial nested execution, the repository applies a
committed pnpm patch:

- `patches/graphql@17.0.2.patch` — patches `executeCollectedSubfields` in graphql's
  `execution` module (`ExecutorThrowingOnIncremental`, the class the standard `execute()`
  path uses), routing nested mutation fields through `executeFieldsSerially`.
- Wired via `pnpm.overrides` (pins the whole dependency tree to one patched copy) and
  `pnpm.patchedDependencies` in the root `package.json`.

This relates to graphql-spec proposal
[#252](https://github.com/graphql/graphql-spec/pull/252). **Downstream consumers must reuse
this patch** for nested mutations to behave correctly.

---

## 13. Known Gaps / Roadmap

The following are recorded in package READMEs as *not yet implemented* and are listed here
for completeness — they do not describe current behavior:

- Validate submitted definitions against JSON Schema v7.
- Reimplement subscriptions.
- Middleware/caching options.
- Additional adapters (Elasticsearch, HTTP GraphQL Relay).
- CI/CD for deployment; expanded documentation and unit-test coverage.

Partially addressed since the READMEs were written (see §5): root-level eager loading now
generates a combined `where`/`include` from the selection set, and cross-adapter relationships
are read as separate root queries. Remaining here: a fully typed where/filter object for the
Sequelize adapter, cross-adapter **writes**, and batching of cross-adapter reads by foreign key.

---

*Generated as an as-built reference. When code and this document disagree, the code in
`packages/*/src` is authoritative — please update this spec accordingly.*
