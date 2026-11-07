# AGENTS.md

How this repo is put together and how to work in it. For *what the library does*, read
[`docs/specifications.md`](docs/specifications.md) (reference) and [`docs/guide.md`](docs/guide.md)
(usage); this file does not repeat them.

## What this is

A pnpm 11 + Turborepo monorepo (Node 24, see `.nvmrc`) for a relational data binder. Models are
defined once on an **ormize** instance, stored through pluggable **adapters**, and projected into
several API surfaces. Everything is published under `@azerothian/*`.

```
graphql-types + utilize  →  ormize  →  gqlize       (GraphQL schema, CLI, schema artifacts)
                                    →  ormize-zod4  (Zod schemas)
                                    →  nestize      (NestJS REST + OpenAPI, uses ormize-zod4)
                                    →  temporalize  (Temporal activities/workers)
adapters: ormize-adapter-sequelize (reference), ormize-adapter-valkey
read-cache stores: MemoryCacheStore (in ormize), ormize-cache-ioredis
```

| Path | Role |
| --- | --- |
| `packages/utilize` | GraphQL-free shared foundation: types (`Definition`, `OrmAdapter`, …), permission gates (`src/gate.ts`), role-based permissions, global-key helpers. |
| `packages/ormize` | Backend manager: definitions, adapters, models, hooks, scopes, relationship mutations, cross-adapter transactions (`src/manager.ts` is the core). |
| `packages/gqlize` | `createSchema(orm, options)`; builders in `src/graphql/create-*.ts`, resolvers in `src/graphql/resolvers/`, artifact build/load in `src/graphql/snapshot/`, CLI in `src/cli/`. |
| `packages/ormize-adapter-*` | Data-source implementations. The sequelize adapter implements `GqlizeAdapter` from gqlize. |
| `packages/ormize-cache-ioredis` | Redis/Valkey `CacheStore` for the read cache (`ormize/src/read-cache/`). |
| `packages/test-fixtures` | Private. Shared model definitions plus the SQLite/PGlite test DB helper (`src/dialect.ts`). Never published. |
| `examples/*` | Runnable consumers. `gqlize-basic/generated/` is committed and diffed by CI. |
| `tools/lint` | ESLint flat config and the TypeScript the linter runs on. |
| `scripts/build`, `scripts/jest` | Build scripts and jest config shared by every package. |
| `patches/graphql@17.0.2.patch` | Makes nested mutation fields run serially. The whole tree is pinned to this one patched graphql. |

## Commands

Run these from the repo root.

```bash
pnpm install --frozen-lockfile
pnpm typecheck   # tsc -b (src) + per-package tsconfig.test.json (__tests__)
pnpm lint        # eslint, type-aware, --max-warnings 0
pnpm build       # each package → its publish/ dir
pnpm test        # jest across all packages; runs against src/, no build needed
pnpm --filter @azerothian/example-gqlize-basic schema:check   # CI schema-drift gate
```

To run one package or one file:

```bash
pnpm --filter @azerothian/gqlize test -- __tests__/mutation.test.ts
pnpm --filter @azerothian/gqlize test -- __tests__/mutation.test.ts --selectProjects sqlite
```

The read-cache benchmark is opt-in and not part of `pnpm test`:

```bash
pnpm --filter @azerothian/gqlize exec jest --selectProjects sqlite \
  --testMatch '**/__tests__/bench/*.bench.ts' --coverage=false
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → build → test → schema drift. Do them in that
order: lint needs a program that compiles.

## Tests

- Jest with `@swc/jest`. Tests live in `packages/*/__tests__/**/*.test.ts`. A test imports its
  siblings' **source** through `moduleNameMapper` (`scripts/jest/module-name-mapper.js`).
- Suites run on **SQLite and Postgres (in-process PGlite)**. In `gqlize`, `packages/gqlize/jest.config.js`
  defines three projects:
  - `sqlite`: every suite.
  - `postgres`: the `POSTGRES_SUITES` list.
  - `roundtrip`: the `ROUNDTRIP_SUITES` list, run against a schema that went build → JSON artifact →
    materialize.

  A new functional suite usually belongs in both lists. Leave pure builder unit tests (`__tests__/graphql/*`)
  as sqlite-only.
- The valkey suites need Redis 7.x. Set `REDIS_URL`, or let `redis-memory-server` download one.
  Temporal integration tests run only with `TEMPORALIZE_INTEGRATION` set.
- `testTimeout` must be set at the root of a jest config. jest-circus ignores it inside a `projects` entry.
- Snapshots (`__snapshots__`, `schema-golden`) are intentional. When the schema shape changes, update
  them deliberately and review the diff.

## Rules that are easy to break

- **Schema drift.** Anything that changes the generated schema means re-running
  `pnpm --filter @azerothian/example-gqlize-basic schema:build` and committing `generated/`. Building a
  schema must never open a DB connection. CI has no SQL service, so it catches that.
- **Primary and foreign keys are not writable by default.** `isStructurallyWritable`
  (`packages/utilize/src/gate.ts`) keeps them out of create/update inputs. This is a mass-assignment/IDOR
  guard. A field opts back in with `writable: true`, or every plain foreign key does with
  `new Ormize({ writableForeignKeys: true })` (applied in `orm.getFields`, so every projection and the
  runtime guard agree). Permission predicates can't re-enable it. Don't loosen the default without an
  explicit decision.
- **Global ids.** Primary and foreign keys are Relay global ids, and a foreign key is typed by its
  `foreignTarget`. `globalKeysFromFields` and `globalKeyTargets` (`packages/utilize/src/utils/global-keys.ts`)
  must agree with the encoder in `create-basic-fields.ts`. Otherwise a key decodes on the way in but isn't
  encoded on the way out.
- **Relationship verbs.** The eight verbs (`create, update, add, set, remove, delete, restore, select`)
  are declared twice: in `gqlize/src/graphql/create-mutation-input.ts` and `ormize/src/relationship-mutations.ts`.
  Keep both in the same order and in sync.
- **Permission keys.** A new key on `Permission` goes in exactly one of `BUILD_TIME_PERMISSION_KEYS` or
  `RESOLUTION_TIME_PERMISSION_KEYS` (`utilize/src/gate.ts`). The typecheck fails if it's missing from
  both or listed in both. Code under `gqlize/src/graphql/*` builds the schema synchronously, so it must
  never call a resolution-time key (such as the possibly-async `scope`).
- **Empty input types are invalid GraphQL.** When permissions strip every field, the type is omitted
  (see `hasInputFields`). Keep that check in step with the builder it mirrors.
- **Cyclic test fixtures.** `gqlize` and `ormize` tests import the sequelize adapter, but they can't
  declare it as a dependency because that would make a cycle. `turbo.json` lists its `src/` as a hash
  input instead. Copy that pattern if you add a similar edge.
- **Read cache invalidation.** The read cache (`ormize/src/read-cache/`) can only invalidate writes it
  sees: `mutationEntry` in `manager.ts` and the adapter's `after*` write hooks (`WRITE_HOOKS`). A new
  write path outside both has to call `readCache.invalidate`, or cached reads stay stale until TTL.
- **Lint ceiling.** Warnings are a ratchet. Never raise the limit; fix the code or lower it.

## Code style

- TypeScript `strict` with `noUnusedLocals`. Match the surrounding code.
- Comments explain *why*: constraints, past bugs (often with an issue number), and invariants shared
  with another file. Keep that density in non-obvious code and update a comment when the code it
  describes changes.
- Don't add dependencies casually. `pnpm-workspace.yaml` lists every package allowed to run install
  scripts (`allowBuilds`), and a new one needs an explicit verdict there.

## Commits, PRs, releases

- Use Conventional Commits with a package scope:
  `fix(sequelize): …`, `test(gqlize): …`, `docs(spec): …`, `chore(examples): …`.
- Work on a branch and merge to `main` via PR.
- To release, push a bare semver tag (e.g. `7.0.0-beta.0`) on `main`.
  `.github/workflows/release.yaml` sets every package's version, builds, and publishes to GitHub
  Packages and npmjs. Package versions in `package.json` are not bumped by hand.
- Behaviour that breaks existing users goes in `docs/migration-6-to-7.md`. Public API and model-definition
  changes go in `docs/specifications.md` and `docs/guide.md`.
