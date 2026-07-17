# valkey-basic

A runnable demo of [`@azerothian/ormize-adapter-valkey`](../../packages/ormize-adapter-valkey) —
an ormize instance backed by Valkey/Redis where retrieval is driven entirely by index and mapping
structures (never a keyspace scan).

It shows:

1. an **index-only query** (`where: { label: "box" }` uses the `label` secondary index),
2. a **relationship read** (`Item.tasks`) resolved through the auto-indexed `itemId` foreign key,
3. **expiry cascading into the mapping data** — an expired `Item` disappears from the `ids` and
   `label` index results (and is purged), with no scan.

## Run

```bash
pnpm --filter @azerothian/example-valkey-basic start
```

By default it boots an ephemeral in-process redis via `redis-memory-server`, so no server is
required. To point at a real Valkey/Redis instead, set `REDIS_URL`:

```bash
REDIS_URL=redis://localhost:6379 pnpm --filter @azerothian/example-valkey-basic start
```

Expected output:

```
1) query label=box → [ 'SKU-1' ]
2) box.tasks (via itemId index) → [ 'pack', 'seal' ] (total 2)
3) expiry cascade → items before=2 after=1 (bag expired out of the ids/label maps)

DEMO: PASS
```
