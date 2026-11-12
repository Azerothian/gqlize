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
| `packages/utilize` | GraphQL-free shared foundation: types (`src/types/`, one file per theme, re-exported from `types/index.ts`), permission gates (`src/gate.ts`), role-based permissions, global-key helpers. |
| `packages/ormize` | Backend manager: definitions, adapters, models, hooks, scopes, relationship mutations, cross-adapter transactions. `src/manager.ts` is the `Ormize` class; the work it delegates lives in `src/engine/`. |
| `packages/gqlize` | `createSchema(orm, options)`; builders in `src/graphql/create-*.ts`, resolvers in `src/graphql/resolvers/`, artifact build/load in `src/graphql/snapshot/`, CLI in `src/cli/`. |
| `packages/ormize-adapter-*` | Data-source implementations. The sequelize adapter implements `GqlizeAdapter` from gqlize; its `src/index.ts` is a thin class over `reads.ts`, `writes.ts`, `model-creation.ts` and siblings. |
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
pnpm --filter @azerothian/gqlize test -- __tests__/mutation-crud.test.ts
pnpm --filter @azerothian/gqlize test -- __tests__/mutation-crud.test.ts --selectProjects sqlite
```

The read-cache benchmark is opt-in and not part of `pnpm test`:

```bash
pnpm --filter @azerothian/gqlize exec jest --selectProjects sqlite \
  --testMatch '**/__tests__/bench/*.bench.ts' --coverage=false
pnpm --filter @azerothian/ormize-cache-ioredis exec jest \
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
- **belongsToMany `through`.** Whether `add`/`set` entries are `{ where, through }` or bare filters
  is decided by `Association.throughModel` (set in `Ormize.getAssociations`) plus `isThroughMode`
  (`utilize/src/gate.ts`) under the caller's permission bag. The GraphQL builder
  (`create-mutation-input.ts`) and the engine (`splitLinkEntry` in
  `ormize/src/relationship-mutations.ts`) both read them; a projection that calls the engine must
  pass its bag as `Selection.permission` (gqlize's `buildPermission`, set by the live build *and*
  the materializer) or the engine will expect a different entry shape than the schema offered.
  Don't decide it locally. A join model with `generated: true` stays out of every projection.
  Reads of a registered join model's relationship go through `engine/through-reads.ts` on every
  adapter (keyed on `throughModel` alone, so the join model's read scope always hides links); never
  let one reach an adapter's JOIN. The include builder plans it only as a `required` filter, which
  `applyThroughRequired` strips out before the adapter runs.
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
  sees: `mutationEntry` in `ormize/src/engine/mutations.ts` and the adapter's `after*` write hooks
  (`WRITE_HOOKS` in `engine/constants.ts`, applied in `engine/hooks.ts`). A new write path outside both
  has to call `readCache.invalidate`, or cached reads stay stale until TTL.
- **Engine hosts stay private.** The `Ormize` class hands `src/engine/*` a private `engine` facade, not
  `this`. Its fields are getters over the manager's private state. Two things depend on that:
  - The permission bag and the §13 scope hooks stay `private`. Widening them so `this` satisfies a host
    interface would let callers bypass `setPermission`'s re-audit, or replace hooks that must run last.
  - A hook keeps its host for the life of the process. A host that *copies* state, instead of reading
    it through a getter, freezes it at model creation. A later `setPermission` would then never reach
    the hooks, and `scope-enforcement.test.ts` pins that it does.

  Add what a new engine module needs to that facade, as a getter or a delegating function.
- **Cache key format.** `cacheEntryKey` (`utilize/src/utils/cache-key.ts`) and the `LOOKUP` Lua script
  in `ormize-cache-ioredis` build the same entry key independently. Change both together, or the Redis
  store never hits.
- **Lint ceiling.** Warnings are a ratchet. Never raise the limit; fix the code or lower it.

## Code layout

Keep every file under 1000 lines where it can be helped, tests included. When a file grows past that,
split it by concern into modules a reader can find by name. Don't split it into numbered parts.

- **Classes stay thin.** A large class (`Ormize`, `SequelizeAdapter`) keeps its state and its public
  members. Each public member delegates to a free function in a sibling module, and that function
  takes a narrow host interface, as `ormize/src/engine/*`, `sequelize/src/query-options.ts` and
  `reads.ts` do. Public members keep their name and kind: an arrow property stays an arrow property,
  because callers pass them around detached.
- **Type barrels.** `utilize/src/types/index.ts` only re-exports the themed files beside it
  (`adapter.ts`, `definitions.ts`, `selection.ts`, `options.ts`, `cache.ts`, `codecs.ts`,
  `relationships.ts`, `primitives.ts`). Import from `types/index` and add new types to the themed
  file they belong in.
- **Test files.** Split a test file by `describe` topic. Put shared setup in `__tests__/helper/` (for
  example `ormize/__tests__/helper/scope-fixtures.ts`). Every new file has to be listed wherever the
  old one was: `POSTGRES_SUITES` / `ROUNDTRIP_SUITES` in the package's `jest.config.js`.
- **Headers.** Every module opens with a short comment saying what it holds and how it relates to its
  neighbours. Don't record where code was moved from: git has that, and the note goes stale.

Where the core logic lives:

| Concern | File |
| --- | --- |
| `Ormize` public API, state, wiring of the facades | `ormize/src/manager.ts` |
| List/relationship reads, `resolveFindAll`, include plans, paging | `ormize/src/engine/resolution.ts` |
| `process*` mutations, `mutationEntry`, instance transforms | `ormize/src/engine/mutations.ts` |
| Nested relationship verbs | `ormize/src/relationship-mutations.ts` |
| Hook composition (`createHook`, `runHook`) and hook lists | `ormize/src/engine/hooks.ts`, `engine/constants.ts` |
| Row scope: engine side / model-hook backstop / audit | `ormize/src/engine/scope-bridge.ts`, `scope-hooks.ts`, `scope-audit.ts` |
| Relationship wiring and cross-adapter join models | `ormize/src/engine/relationships.ts`, `cross-adapter.ts` |
| Read-cache tagging / the cache itself | `ormize/src/engine/read-cache-bridge.ts`, `read-cache/` |
| Sequelize reads / writes / model creation | `ormize-adapter-sequelize/src/reads.ts`, `writes.ts`, `model-creation.ts` |

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
