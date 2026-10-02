# example: mikro-orm-basic

A GraphQL API generated from an **existing MikroORM instance** — no ormize definitions are written
anywhere in this example.

`src/entities.ts` is plain MikroORM: two entities and a one-to-many between them, and nothing that
knows ormize or GraphQL exists. `src/orm.ts` registers the instance and calls `initialise()`; the
models come out of MikroORM's own metadata from there.

```bash
pnpm --filter @azerothian/example-mikro-orm-basic query    # run one query, print the result
pnpm --filter @azerothian/example-mikro-orm-basic start    # serve GraphiQL on :4000
```

## Schema artifacts

`generated/` holds a committed schema artifact and its SDL sidecar, rebuilt with:

```bash
pnpm --filter @azerothian/example-mikro-orm-basic schema:build
pnpm --filter @azerothian/example-mikro-orm-basic schema:check   # CI drift gate
```

`gqlize.config.ts` points at `buildOrmForSchema`, which uses MikroORM's **synchronous** constructor:
it discovers entities and opens nothing, and this adapter's discovery reads that metadata without
connecting either. So `schema:check` runs with no database at all — which is what makes it a
meaningful gate rather than a test of the CI service container.

## Things to notice in the output

- `Task.itemId` — MikroORM has no scalar property for `Task.item`'s key, so the adapter synthesizes
  one, typed by what it points at. Its relay global id decodes to `Item:1`, not `Task:1`.
- `Task.createdAt` and both `id`s are absent from the create input: MikroORM writes them itself, so
  offering them would accept a value and discard it.
- `done` has a default, so it is optional on create but still non-null in the output type.

See the [adapter README](../../packages/ormize-adapter-mikro-orm) for the options, the soft-delete
opt-in, and the limitations.
