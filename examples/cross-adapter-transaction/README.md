# cross-adapter-transaction

A runnable demonstration of a **coordinated ormize transaction across two
adapters** — an in-memory **SQLite** and an in-memory **Postgres** (PGlite,
running in-process over a unix socket) — plus **AsyncLocalStorage request-context
tracking**.

One `Ormize` instance registers two adapters:

- `"sqlite"` hosts the `Order` model,
- `"pg"` hosts the `Payment` model.

`orm.transaction(fn)` runs `fn` as one coordinated unit of work: it lazily opens a
transaction on each adapter it touches, commits them all on success, and **rolls
them all back if anything fails** — even though they are two separate database
connections.

```ts
await orm.transaction(async () => {
  await orm.processCreate("Order",   null, { input: { ref: "ORD-1" } }, {}, undefined);        // SQLite
  await orm.processCreate("Payment", null, { input: { orderRef: "ORD-1", amount: 100 } }, {}, undefined); // Postgres
});
```

If the `Payment` write fails on Postgres (here: a `NOT NULL` violation), the
`Order` already written on the SQLite adapter is rolled back too.

## Run

```bash
pnpm --filter @azerothian/example-cross-adapter-transaction start
```

Expected output:

```
1) committed  → Orders(sqlite)=1  Payments(pg)=1
2) failed     → rolled back both, cause: notNull Violation: Payment.amount cannot be null
   after fail → Orders(sqlite)=1  Payments(pg)=1 (ORD-2 must be absent)
3) context    → hook observed user: {"user":"alice"}
DEMO: PASS — a Postgres failure rolled back the SQLite write, and the hook saw the ambient context.
```

## Ambient context

`orm.runWithContext(context, fn)` makes `context` available anywhere inside `fn`
via `orm.getContext()` — including inside `definition.before`/`after` hooks —
without threading it through every call. The `Order` model's `before` hook reads
`orm.getContext()` and sees `{ user: "alice" }` set by the caller.

## Caveat — best-effort, not two-phase commit

Cross-adapter coordination rolls back cleanly when a failure happens **during**
the work. It is **not** XA/two-phase commit: if a failure occurs during the final
commit phase, after some adapters have already committed, those cannot be undone.
SQLite and Postgres provide no distributed transaction protocol. For most
application flows (validate → write several stores → commit) the mid-work
rollback guarantee is what matters.
