# gqlize — Technical Specification

> **Status:** As-built specification. This document describes the system as it exists in
> the code today (version `6.0.0`). It is descriptive, not a requirements wishlist —
> unimplemented ideas are collected in [§13 Known Gaps / Roadmap](#13-known-gaps--roadmap).
> Source of truth is `packages/*/src`; file paths are given throughout so every claim can
> be checked against the code.

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

Metadata: version `6.0.0`, MIT licensed, npm scope `@azerothian`, Node.js ≥ 20.

---

## 2. Architecture & Package Layout

The repository is a **pnpm workspaces + Turborepo** monorepo. The dependency graph is
acyclic:

```
graphql-types (leaf)
gqlize-shared (leaf) ──► gqlize (core) ──► gqlize-adapter-sequelize (adapter)
```

| Package | Path | Responsibility |
| --- | --- | --- |
| [`@azerothian/gqlize`](../packages/gqlize) | `packages/gqlize` | Core databinder: schema generation, Relay connections, field/model permissions, lifecycle hooks. Key files: `src/manager.ts` (`GQLManager`), `src/graphql/*` (builders), `src/permission-helper.ts`. |
| [`@azerothian/gqlize-adapter-sequelize`](../packages/gqlize-adapter-sequelize) | `packages/gqlize-adapter-sequelize` | Reference `GqlizeAdapter` implementation over Sequelize 6. Entry: `src/index.ts`; `src/type-mapper.ts`, `src/utils/where-ops.ts`, `src/utils/replace-id-deep.ts`. |
| [`@azerothian/gqlize-shared`](../packages/gqlize-shared) | `packages/gqlize-shared` | Shared type surface (`GqlizeAdapter`, `Definition`, `DefinitionField*`, `Association`, `Relationship`, `WhereOperators`, options/cache types), the `Events` enum, and utilities (`logger`, `unique`, `word`, `waterfall`). |
| [`@azerothian/graphql-types`](../packages/graphql-types) | `packages/graphql-types` | Custom GraphQL scalars (`json`, `date`, `bigint`, `float`, `ip`, `upload`) and `createQueryType`. A local copy of `@vostro/graphql-types`. |

> **Note:** the root `README.md` package table lists only the first three; `graphql-types`
> is a fourth workspace package and is documented here for completeness.

Root configuration files: `package.json` (scripts, `pnpm@9.15.9`, graphql override/patch),
`pnpm-workspace.yaml` (`packages/*`), `turbo.json` (task pipeline), `tsconfig.base.json`
(shared compiler options + `@azerothian/*` → `src/` path aliases), `tsconfig.json`
(`tsc -b` project references), and `patches/graphql@16.8.1.patch`.

---

## 3. Public API & Usage Lifecycle

The core package (`packages/gqlize/src/index.ts`) exports exactly two symbols:

```ts
export const Database = GQLManager;   // the manager class (default export of ./manager)
export const createSchema = create;   // from ./graphql/index
```

The Sequelize adapter's public API is its default-export class `SequelizeAdapter`.

### Consumer lifecycle

Canonical flow (see `packages/gqlize/__tests__/helper/index.ts`):

```ts
import { Database, createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";

// 1. Create the manager
const db = new Database();

// 2. Register one or more data-source adapters (the first becomes the default)
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");

// 3. Register model definitions (optionally per adapter)
db.addDefinition(TaskDefinition);
db.addDefinition(ItemDefinition);

// 4. Wire relationships across adapters, then bring adapters online
await db.initialise();
await db.sync();

// 5. Build the GraphQL schema
const schema = await createSchema(db, options /* GqlizeOptions */);
```

The resulting `schema` is a standard `graphql` `GraphQLSchema` and is executed with the
stock `graphql()` executor. A `schema.$sql2gql = { types }` property is attached for
introspection of the generated types.

### Key `GQLManager` methods

Consumer-facing (`packages/gqlize/src/manager.ts`):

- `registerAdapter(adapter, overrideName?)` — register an adapter; first one becomes `defaultAdapter`.
- `addDefinition(def, adapterName?)` — register a model definition (validates a unique `name`, wires the hook map, calls `adapter.createModel`).
- `initialise()` — process all relationships, then `initialise()` every adapter.
- `sync(options?)` / `reset(options?)` — delegate to adapters.
- Hook registration: `addHook`, `addHookObject`, `unshiftHook`, `unshiftHookObject`, `createHook`.
- Introspection: `getModel(s)`, `getDefinition(s)`, `getFields`, `getAssociations`, `getGlobalKeys`.

Internal resolution methods invoked by generated resolvers:

- `resolveFindAll` — list query resolver (cursor→offset, `adapter.processListArgsToOptions` → `adapter.findAll` + count, fires `before` with `Events.QUERY`).
- `resolveSingleRelationship` / `resolveManyRelationship` — relationship resolvers.
- `resolveClassMethod` — invokes `Model[methodName](args, context)` with optional before/after.
- `processCreate` / `processUpdate` / `processDelete` — mutation executors; run `processInputs`, translate global IDs (`replaceIdDeep`), fire the matching `Events.MUTATION_*` hook, delegate to adapter functions, then `processRelationshipMutation`.
- `processRelationshipMutation` — the nested-mutation engine (see §5).

---

## 4. Model Definition Schema

A **Definition** is the plain object passed to `db.addDefinition`. The full type lives in
`packages/gqlize-shared/src/types/index.ts` (`Definition`). The canonical, full-featured
example is `packages/gqlize/__tests__/helper/models/task.ts`.

### Fields

| Key | Purpose |
| --- | --- |
| `name` | Unique model name (required). |
| `datasource` | Optional adapter name; defaults to the manager's default adapter. |
| `define` | Field map. Each value is a `DefinitionField`: `type`, `allowNull`, `primaryKey`, `foreignKey`, `unique`, `defaultValue`, `values` (enum), `validate`, `description`, `comment`. |
| `override` | Per-field custom GraphQL type plus `input`/`output` transform functions (e.g. storing JSON in a string column but exposing a typed object). |
| `ignoreFields` | Columns to exclude from the generated type. |
| `relationships` | Array of `Relationship`: `{ model, name, type, options }` where `type ∈ hasOne | belongsTo | hasMany | belongsToMany` and `options` carries `as`, `foreignKey`, `sourceKey`, `through`, `constraints`. |
| `whereOperators` / `whereOperatorTypes` | Custom filter operators (async functions returning a where fragment) and their GraphQL input types. |
| `expose` | Declares which methods surface to GraphQL: `expose.classMethods.{query,mutations}` and `expose.instanceMethods.{query,mutations}`, each `{ type, args, before?, after? }`. `type` may be a string model reference (`"Task"`) or a list (`"Task[]"`), or a concrete GraphQL type. |
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

Extra mutation fields may be injected via `options.extend.mutation`. Subscriptions are
supported via `options.subscriptions`.

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
  `permission.queryInstanceMethods`.

### Mutation inputs & deep writes

`create-mutation-input.ts` generates `{Def}RequiredInput` (create), `{Def}OptionalInput`
(update), `{Def}UpdateInput` (`where`/`limit`/`input`), and delete filter inputs. For each
association it also emits nested sub-fields, enabling deep writes, applied by
`processRelationshipMutation` (`packages/gqlize/src/manager.ts`) via the Sequelize association
accessors (recursion depends on the graphql patch, see §12). The sub-fields per association type:

- **hasMany / belongsToMany:** `create` (new records), `update` (`where`+`input` pairs),
  `add` (associate existing by where), `set` (replace the entire set with matching existing
  records), `remove` (disassociate matching), `delete` (delete matching), `restore` (undelete
  soft-deleted matching, paranoid models). For **belongsToMany**, `add`/`set` entries are
  `{ where, through }` where `through` (a JSON payload) writes join-table column values.
- **belongsTo / hasOne:** `create`, `update`, `set` (associate an existing record found by a
  where filter → `accessors.set`), `remove` (`Boolean` → disassociate via `set(null)`),
  `delete`, `restore`.

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

For a top-level list query, `resolveFindAll` (`packages/gqlize/src/manager.ts`) resolves the
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
default list args (`where` filter + `include`). Cursors are base64-encoded, index-based
(`graphql/objects/cursor.ts`, `graphql/utils/base64.ts`). This differs from stock
`graphql-relay` connections in that each connection carries a `total` count — backed on
supported dialects by an inline `COUNT(*) OVER()` (`hasInlineCountFeature` /
`getInlineCount`) to avoid a second query.

Primary-key and foreign-key fields are exposed as Relay **global IDs** via `graphql-relay`
(`fromGlobalId` / `toGlobalId`). Global IDs are transparently translated back to raw IDs
across both queries and mutations by `replaceIdDeep`
(`packages/gqlize-adapter-sequelize/src/utils/replace-id-deep.ts` and the manager's
`replace-id-deep` util). A shared node interface and type mapper resolve a global ID back to
its concrete object type.

---

## 7. Permissions

Permissions are configured via `options.permission` (type `GqlizeOptions.permission` in
`packages/gqlize-shared/src/types/index.ts`) and consulted throughout
`packages/gqlize/src/graphql/*`. Each callback returns a boolean; returning falsy omits the
corresponding schema element.

| Callback | Gates |
| --- | --- |
| `model(defName, options)` | Whether the model type is generated at all. |
| `query(defName, options)` | The list query for a model. |
| `mutation` / `mutationCreate` / `mutationUpdate` / `mutationDelete` | Mutation operations. |
| `mutationCreateInput` / `mutationUpdateInput` (field, fieldName, options) | Individual input fields. |
| `field(defName, fieldName, options)` | Individual output fields. |
| `relationship(relName, targetName, options)` | Relationship fields. |
| `queryClassMethods` / `mutationClassMethods` | Exposed class methods. |
| `queryInstanceMethods` | Exposed instance-method query fields. |
| `queryExtension` / `mutationExtension` | `options.extend.*` fields. |

A shared `options.permission.options` value is threaded into every callback.

### Role-based helper

`packages/gqlize/src/permission-helper.ts` provides
`createRoleBasedPermissions(role, rules, options)`, which compiles an allow/deny rules tree
(merged with defaults via `deepmerge`, honoring `defaultDeny` and `allow`/`deny` leaves)
into the `permission` object above — so consumers can declare permissions per role rather
than writing every callback by hand.

---

## 8. Lifecycle Hooks & Events

gqlize has two distinct hook systems.

### 1. Sequelize-style lifecycle hooks

The manager recognizes a full list of Sequelize lifecycle hook names (`hookList` in
`packages/gqlize/src/manager.ts`): `beforeValidate`/`afterValidate`, `validationFailed`,
`beforeCreate`/`afterCreate`, `beforeUpdate`/`afterUpdate`, `beforeDestroy`/`afterDestroy`,
`beforeSave`/`afterSave`, `beforeFind`/`afterFind`, `beforeCount`, `beforeBulk*`,
`beforeConnect`/`afterConnect`, `beforeSync`/`afterSync`, `beforeQuery`/`afterQuery`, and
more. Hooks may be registered globally (`options.globalHooks`) or per-definition
(`def.hooks` / `def.options.hooks`). `createHook` composes per-definition hooks followed by
global hooks into a `waterfall` pipeline, so each hook receives the previous hook's return
value. A hook may be a single function or an array of functions.

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

Defined in `packages/gqlize-shared/src/events.ts`:

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
(`packages/gqlize-shared/src/types/index.ts`). The Sequelize adapter
(`packages/gqlize-adapter-sequelize/src/index.ts`) is the reference implementation. The
contract groups into:

- **Lifecycle:** `createModel`, `initialise`, `sync`, `reset`.
- **Introspection:** `getModel`, `getFields` (→ `DefinitionField`), `getAssociations`
  (→ `Association`), `getPrimaryKeyNameForModel`, `getValueFromInstance`.
- **Type mapping:** `getTypeMapper`, `getDefaultListArgs`, `getOrderByGraphQLType`,
  `getFilterGraphQLType`.
- **Relationships:** `createRelationship`, `createFunctionForFind`,
  `resolveManyRelationship`, `resolveSingleRelationship`.
- **Querying:** `processListArgsToOptions`, `findAll`, `count`, `hasInlineCountFeature`,
  `getInlineCount`, `processFilterArgument`, `replaceIdInArgs`.
- **Mutations:** `getCreateFunction`, `getUpdateFunction`, `getDeleteFunction`, `update`.

### Sequelize adapter highlights

- `createModel` calls `sequelize.define(name, define, options)`, attaches class/instance
  methods (including SQL-generating class methods), and stashes the `definition` on the model.
- `getFields` reflects over `rawAttributes` to derive `primaryKey`, `allowNull`,
  `foreignKey`/`foreignTarget`, and `autoPopulated`.
- Filtering: `createQueryType` (from `@azerothian/graphql-types`) builds the `where` input;
  `processFilterArgument` → `replaceWhereOperators` (`utils/where-ops.ts`) maps GraphQL
  operator names to Sequelize `Op.*`, and custom `definition.whereOperators` are resolved.
- `getOrderByGraphQLType` builds a `{Def}OrderBy` enum (`fieldASC` / `fieldDESC`);
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
| `FloatType` | `.../float` | Float handling. |
| `IPType` | `.../ip` | IP addresses. |
| `JSONType` | `.../json` | Arbitrary JSON. |
| `UploadType` | `.../upload` | File uploads. |
| `createQueryType`, `defaultConfig` | `.../query` | Builds the `where`/filter input type used by adapters. |

---

## 11. Build, Test & Tooling

- **Orchestration:** Turborepo + pnpm. Root scripts: `build` (`turbo run build`), `test`
  (`turbo run test`), `typecheck` (`tsc -b`), `watch`.
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
- **Runtime:** Node.js ≥ 20.
- **Publishing:** per-package `pnpm build` → `publish/` → `package:npm` / `package:yalc`.

> There is currently no CI configuration in the repository.

---

## 12. The graphql Patch

`graphql@16.8.1` is a **pinned peer dependency**. gqlize requires a mutation's *nested*
sub-fields to execute serially, but stock graphql only serializes *top-level* mutation
fields — nested sub-fields run asynchronously. Because gqlize's deep relationship mutations
(create/update/delete/add/remove) rely on serial nested execution, the repository applies a
committed pnpm patch:

- `patches/graphql@16.8.1.patch` — patches `completeObjectValue` in graphql's
  `execution/execute` module.
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
