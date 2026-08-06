# temporalize worker example

A minimal, **runnable** pair of Temporal processes built from an
[`@azerothian/ormize`](../../packages/ormize) instance with
[`@azerothian/temporalize`](../../packages/temporalize). It defines two models
(`Item` has many `Task`), launches one worker per task queue, and drives CRUD,
class methods and instance methods through Temporal workflows.

The same `Item`/`Task` definitions appear in the
[gqlize GraphQL example](../gqlize-basic) and the
[nestize REST example](../nestize-rest) — all three packages are different
projections of one ormize instance.

## Prerequisites

A Temporal dev server on `localhost:7233`:

```sh
temporal server start-dev     # https://docs.temporal.io/cli — Web UI on :8233
```

## Run it

From the **repo root** (installs the whole workspace once):

```sh
pnpm install
```

Then, in two terminals:

```sh
pnpm --filter @azerothian/example-temporalize-worker start:worker
# queue map: { "byModel": { "Item": "example.sqlite.Item", … } }
# worker polling example.sqlite.Item (models: Item)
# worker polling example.sqlite.Task (models: Task)
```

```sh
pnpm --filter @azerothian/example-temporalize-worker start:client
# created Item: { id: 1, label: 'Groceries' }
# outstanding tasks: { total: 1, rows: [ { id: 1, name: 'Buy milk', … } ] }
# Item.labelsUpper: [ 'GROCERIES' ]
# Item.describe: Groceries (list)
# reader sees 2 tasks
# reader create rejected: TemporalizeForbidden - temporalize: mutations not allowed for Task
#   nonRetryable: true
```

Open <http://localhost:8233> to watch the executions: each one is a generic
workflow (`createWorkflow`, `findAllWorkflow`, …) running a single activity named
`Task.create` / `Item.classMethods.labelsUpper` on task queue
`example.sqlite.Task` / `example.sqlite.Item`.

The last client call is the interesting one. It is denied by the permission
gate, and temporalize raises a **non-retryable** `ApplicationFailure` — so the
workflow fails immediately. Temporal wraps it twice on the way out
(`WorkflowFailedError` → `ActivityFailure` → `ApplicationFailure`), which is why
the client reads `e.cause.cause`. Comment out the `resolvePermission` hook in
[`src/shared.ts`](src/shared.ts) and it succeeds; make the failure retryable
instead and you would watch the Web UI retry a `403` forever, which is the whole
reason for the distinction.

## How it wires together

| File | Responsibility |
| --- | --- |
| [`src/models.ts`](src/models.ts) | Two ormize `Definition`s plus a `classMethod`, an `instanceMethod`, and a `before` hook that reads the caller's context. |
| [`src/orm.ts`](src/orm.ts) | `new Ormize()` → `registerAdapter` → `addDefinition` → `initialise()` → `sync()`. Worker-side only. |
| [`src/shared.ts`](src/shared.ts) | Queue prefix, the role rules behind `resolvePermission`, and the queue map as plain JSON. |
| [`src/worker.ts`](src/worker.ts) | `createWorkers(orm, options)` → one worker per queue → `runAll()`. |
| [`src/client.ts`](src/client.ts) | `createTemporalizeClient(new Client(), QUEUE_MAP)` → `.model("Task").create({ context, input })`. |

The client is built from the hardcoded queue map in `src/shared.ts` on purpose:
a dispatching process needs no ormize instance and no database connection, only
the queue names. The worker prints `buildQueueMap(orm, options)` at startup so
you can see the two agree.

## Notes

- `workflowsPath` points at the temporalize **source** here, because the package
  is consumed from source inside this workspace. In your own app it is
  `require.resolve("@azerothian/temporalize/workflows")`.
- The database is in-memory, so it resets with the worker. Durable execution
  assumes the opposite — use a real database before drawing conclusions about
  retry behaviour.
- Activity retries are at-least-once: a `create` that times out after the row was
  written will duplicate it on retry. See the
  [package README](../../packages/temporalize/README.md#caveats).
