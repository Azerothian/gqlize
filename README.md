# gqlize

A relational data binder that generates GraphQL schemas over multiple data sources through
pluggable adapters. This is a [pnpm](https://pnpm.io/) + [Turborepo](https://turborepo.com/)
monorepo.

## Packages

| Package | Description |
| --- | --- |
| [`@azerothian/gqlize`](packages/gqlize) | Core databinder: schema generation, relay connections, field/model permissions, lifecycle hooks. |
| [`@azerothian/gqlize-adapter-sequelize`](packages/gqlize-adapter-sequelize) | Sequelize adapter — the reference data-source implementation. |
| [`@azerothian/gqlize-shared`](packages/gqlize-shared) | Shared type surface (`GqlizeAdapter`, `Definition`, …), the `Events` enum, and common utilities used by the two packages above. |

Dependency graph (acyclic): `gqlize-shared` ← `gqlize` ← `gqlize-adapter-sequelize`.

## Prerequisites

- **Node.js** ≥ 20
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
`gqlize-shared` → `gqlize` → `gqlize-adapter-sequelize`). Tests run against **source** via Jest
`moduleNameMapper`, so no build is required to run them.

## Workspace layout

```
.
├── turbo.json            # task pipeline
├── tsconfig.base.json    # shared compiler options + path aliases (source resolution)
├── tsconfig.json         # solution config referencing every package (tsc -b)
├── pnpm-workspace.yaml
└── packages/
    ├── gqlize/
    ├── gqlize-adapter-sequelize/
    └── gqlize-shared/
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

`graphql` is a **peer dependency** (`^16.8.1`). gqlize needs a mutation's **nested** sub-fields to
execute serially (stock graphql only serializes top-level mutation fields). Rather than shipping a
graphql fork, this repo applies a committed [pnpm patch](https://pnpm.io/cli/patch),
`patches/graphql@16.8.1.patch`, via `pnpm.patchedDependencies`; `pnpm.overrides` pins the whole tree
to that single patched `graphql@16.8.1`. Downstream consumers who need this behaviour can reuse the
same patch file.

## Publishing

From a package directory, `pnpm build` populates `publish/`, then publish from there
(`package:npm` / `package:yalc`).

## License

GPL-3.0
