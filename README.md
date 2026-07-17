# gqlize / ormize

A relational data binder that generates GraphQL schemas over multiple data sources through
pluggable adapters. This is a [pnpm](https://pnpm.io/) + [Turborepo](https://turborepo.com/)
monorepo.

The project is split into two layers: **`@azerothian/ormize`** (GraphQL-free backend manager —
definitions, adapters, models, hooks, sync, relationships) and **`@azerothian/gqlize`** (GraphQL
layer that accepts an `Ormize` instance and generates the full schema).

## Documentation

- 📘 [**docs/guide.md**](docs/guide.md) — **usage guide**: how to define models, serve the
  schema, and write queries & mutations for every feature, with copy-pasteable examples.
- 📄 [**docs/specifications.md**](docs/specifications.md) — **reference**: architecture, public
  API, model definition schema, permissions, hooks, and the adapter contract.

## Quick start

```ts
import { Ormize } from "@azerothian/ormize";
import { createSchema } from "@azerothian/gqlize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import { graphql } from "graphql";

const db = new Ormize();
db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");
db.addDefinition({ name: "Author", define: { name: { type: Sequelize.STRING, allowNull: false } } });
await db.initialise();
await db.sync();

const schema = await createSchema(db);
await db.models.Author.create({ name: "Ada" });

const result = await graphql({
  schema,
  source: `query { models { Author { edges { node { id name } } } } }`,
});
```

See the [usage guide](docs/guide.md) for models, relationships, filtering, pagination, nested
mutations, permissions, hooks, and more.

## Packages

| Package | Description |
| --- | --- |
| [`@azerothian/ormize`](packages/ormize) | GraphQL-free backend manager — `Ormize` class, `registerAdapter`, `define`/`addDefinition`, models, hooks, `initialise`/`sync`/`reset`, relationship wiring, and the definition typesystem. No GraphQL dependency. |
| [`@azerothian/gqlize`](packages/gqlize) | GraphQL layer — `createSchema(orm, options)` accepts an `Ormize` instance and generates the full Relay-style schema: object types, connections, queries, deep nested mutations, and permissions. |
| [`@azerothian/ormize-adapter-sequelize`](packages/ormize-adapter-sequelize) | Sequelize adapter — the reference data-source implementation. Same `SequelizeAdapter` default export, same `defineModel`/`SequelizeModel` typesystem exports. |
| [`@azerothian/ormize-zod4`](packages/ormize-zod4) | Zod v4 projection — `generateZodSchemas(orm, options)` produces permission-gated entity/create/update schemas per model from the same ormize instance. |
| [`@azerothian/nestize`](packages/nestize) | NestJS REST + Swagger projection — `NestizeModule.forRoot(orm, options)` exposes full CRUD + relationship + `_actions` routes over the ormize resolution engine, with an OpenAPI doc built from the ormize-zod4 schemas. |
| [`@azerothian/utilize`](packages/utilize) | Shared foundation (GraphQL-free): the type surface (`OrmAdapter` backend interface, `Definition`, `DataType`/`DataTypes`, `Selection`, …), the `Events` enum, permission gate helpers + `createRoleBasedPermissions`, and common utilities used by the packages above. The `GqlizeAdapter` graphql extension lives in `@azerothian/gqlize`. |
| [`@azerothian/graphql-types`](packages/graphql-types) | Standalone GraphQL scalar types (json, date, bigint, ip, upload, query) exposed as subpath imports. |

Dependency graph (acyclic): `graphql-types` + `utilize` → `ormize` → { `gqlize`, `ormize-zod4`, `nestize` } ; the sequelize adapter implements `GqlizeAdapter` (from `@azerothian/gqlize`) and is registered on an `Ormize`. `gqlize` (GraphQL), `ormize-zod4` (Zod) and `nestize` (REST) are three projections of one `Ormize` instance.

## Examples

Runnable example projects live under [`examples/`](examples) — each builds the same `Item`/`Task`
domain on an in-memory SQLite ormize instance and can be started from the repo root after `pnpm install`:

| Example | What it shows | Run |
| --- | --- | --- |
| [`examples/gqlize-basic`](examples/gqlize-basic) | A GraphQL API (graphql-yoga + GraphiQL) from `createSchema(orm)`. | `pnpm --filter @azerothian/example-gqlize-basic start` |
| [`examples/nestize-rest`](examples/nestize-rest) | A NestJS REST API + Swagger UI from `NestizeModule.forRoot(orm)`. | `pnpm --filter @azerothian/example-nestize-rest start` |
| [`examples/cross-adapter-transaction`](examples/cross-adapter-transaction) | A coordinated `orm.transaction()` across SQLite **and** in-memory Postgres (a failure on one rolls back the other), plus `AsyncLocalStorage` context tracking. | `pnpm --filter @azerothian/example-cross-adapter-transaction start` |

## Prerequisites

- **Node.js** ≥ 24
- **pnpm** 9 (`corepack enable` will pick up the pinned version in `package.json`)
- **Bun** (optional) — supported at runtime via a `bun` export condition (see below)

## Getting started

```bash
pnpm install
pnpm build        # turbo run build   — builds every package into its publish/ dir
pnpm test         # turbo run test    — Jest (swc-jest) across all packages
pnpm typecheck    # tsc -b            — TypeScript project-references build
pnpm watch        # turbo run watch   — tsc --watch per package
```

Turbo caches task results and respects the dependency graph (e.g. `build` runs
`utilize` → `ormize` → `gqlize` → `ormize-adapter-sequelize`). Tests run against **source** via Jest
`moduleNameMapper`, so no build is required to run them.

## Workspace layout

```
.
├── turbo.json            # task pipeline
├── tsconfig.base.json    # shared compiler options + path aliases (source resolution)
├── tsconfig.json         # solution config referencing every package (tsc -b)
├── pnpm-workspace.yaml
└── packages/
    ├── ormize/
    ├── gqlize/
    ├── ormize-adapter-sequelize/
    ├── ormize-zod4/
    ├── nestize/
    ├── utilize/
    └── graphql-types/
examples/
    ├── gqlize-basic/               # GraphQL (graphql-yoga) example
    ├── nestize-rest/               # NestJS REST + Swagger example
    └── cross-adapter-transaction/  # Coordinated tx across SQLite + Postgres (PGlite)
```

## Module formats

Each package's `build` produces a `publish/` directory consumed by npm. `scripts/prepare-package.ts`
generates the `exports` map (one entry per source file) with three conditions:

- **`import`** → `./lib/*.mjs` — native ES modules (SWC, with relative import extensions rewritten
  for Node's ESM resolver by `scripts/fix-esm-extensions.ts`).
- **`require`** → `./cjs/*.js` — CommonJS (SWC).
- **`bun`** → `./src/*.ts` — the TypeScript **source**, so [Bun](https://bun.sh/) runs it directly
  with no build step.

Type declarations (`./types/*.d.ts`) are emitted by `tsc`. `workspace:*` dependency ranges are
rewritten to concrete versions at publish time so the packages install standalone.

## GraphQL

`graphql` is a **peer dependency** (`^17.0.0`). gqlize needs a mutation's **nested** sub-fields to
execute serially (stock graphql only serializes top-level mutation fields). Rather than shipping a
graphql fork, this repo applies a committed [pnpm patch](https://pnpm.io/cli/patch),
`patches/graphql@17.0.2.patch`, via `pnpm.patchedDependencies`; `pnpm.overrides` pins the whole tree
to that single patched `graphql@17.0.2`. Downstream consumers who need this behaviour can reuse the
same patch file.

## Publishing

From a package directory, `pnpm build` populates `publish/`, then publish from there
(`package:npm` / `package:yalc`).

## License

MIT
