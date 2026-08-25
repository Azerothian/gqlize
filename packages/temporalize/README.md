# @azerothian/temporalize

Generate [Temporal](https://temporal.io) activities, workflows and per-queue
workers from an [`@azerothian/ormize`](../ormize) instance — the durable-execution
analogue of [`@azerothian/gqlize`](../gqlize) (GraphQL) and
[`@azerothian/nestize`](../nestize) (REST). No GraphQL dependency: it drives the
same graphql-free ormize resolution engine, so all three transports share
resolution, filtering, relationships and permission rules.

Every model gets activities for its CRUD surface plus its `classMethods` and
`instanceMethods`. A task queue maps to a model (table), so queues scale
independently. Every call carries an opaque `context` that reaches ormize's
ambient store — and, optionally, a permission gate derived from it.

> **Runnable example:** [`examples/temporalize-worker`](../../examples/temporalize-worker) —
> models → ormize → workers → client, against `temporal server start-dev`.

## Install

```sh
npm install @azerothian/temporalize @azerothian/ormize @azerothian/ormize-zod4 \
  @temporalio/activity @temporalio/client @temporalio/common \
  @temporalio/worker @temporalio/workflow
```

## Usage

### Worker

```ts
import { createWorkers } from "@azerothian/temporalize";
import { buildOrm } from "./orm"; // your initialised ormize instance

const workers = await createWorkers(await buildOrm(), {
  queuePrefix: "myapp",
  // Serve temporalize's generic CRUD workflows. Omit for activity-only workers.
  workflowsPath: require.resolve("@azerothian/temporalize/workflows"),
});

console.log(workers.workers.map((w) => w.queue)); // [ "myapp.sqlite.Item", "myapp.sqlite.Task" ]
await workers.runAll();
```

### Client

```ts
import { Client } from "@temporalio/client";
import { createTemporalizeClient } from "@azerothian/temporalize";

const t = createTemporalizeClient(new Client(), orm, { queuePrefix: "myapp" });
const context = { userId: "u1", role: "admin" };

await t.model("Task").create({ context, input: { name: "alpha" } });
await t.model("Task").findAll({ context, where: { done: { eq: false } }, limit: 10 });
await t.model("Item").classMethod("labelsUpper", { context });
```

`createTemporalizeClient` also accepts a plain queue map, so a client process
needs no ormize instance and no database connection:

```ts
const queueMap = buildQueueMap(orm, { queuePrefix: "myapp" }); // plain JSON — ship it
const t = createTemporalizeClient(new Client(), queueMap);
```

### Your own workflows

The generic workflows are one activity each. For real orchestration, drive the
activities directly with a typed proxy — from workflow code:

```ts
// workflows.ts — bundled into the sandbox, so no ormize imports here
import { createModelProxy } from "@azerothian/temporalize/workflows";

const task = createModelProxy("Task", { startToCloseTimeout: "1 minute" });
const item = createModelProxy("Item");

export async function onboard(context: any, name: string) {
  const [created] = await item.create({ context, input: { label: name } });
  await task.create({ context, input: { name: "welcome", itemId: created.id } });
  return created;
}
```

Point the worker at your own module instead
(`workflowsPath: require.resolve("./workflows")`) and re-export temporalize's
generic workflows from it if you want both.

## Activities

Activity names are flat and dotted, so a worker can register several models:

| Activity                      | Engine call                        |
| ----------------------------- | ---------------------------------- |
| `Task.create`                 | `processCreate`                    |
| `Task.findAll`                | `resolveFindAll` → `{ total, rows }` |
| `Task.findOne`                | `resolveFindAll`, first row or `null` |
| `Task.findByPk`               | `resolveFindAll` by primary key    |
| `Task.count`                  | `resolveFindAll` count only        |
| `Task.update`                 | `processUpdate`                    |
| `Task.destroy`                | `processDelete`                    |
| `Task.select`                 | `processSelect` — relationship sub-mutations |
| `Task.classMethods.<name>`    | `resolveClassMethod`               |
| `Task.instanceMethods.<name>` | load by pk, then call the method   |

Every input is `{ context, ...args }`; `context` is **required**. Filters use the
same per-field operator object gqlize uses (`{ field: { eq, in, like, gte, … } }`
with `and`/`or`/`not`). Lists page with `limit`/`offset`.

`select` is a **mutation, not a finder** — it matches rows by `where` and then
runs relationship mutations against them from `input`. It is gated as an update.

`Task.instanceMethods.<name>` covers the *implementations* under `options.instanceMethods` — one
namespace shared by both `expose` targets — so every declared method has an activity. Which
`expose` target named it decides how the activity behaves:

| Declared under | Gate | Behaviour | Result |
| --- | --- | --- | --- |
| `expose.instanceMethods.mutations` | `permission.mutationInstanceMethods`, **and** `readOnly` plus the model's `mutationUpdate` gate | run as a pre-commit transform through `processUpdate` with an empty input and an `apply` bag — the same path gqlize's `apply` argument takes, so it gets the persist, the recording proxy and scope enforcement | the persisted row |
| `expose.instanceMethods.query`, or neither target | `permission.queryInstanceMethods` | load the row by primary key and call the method | whatever the method returned |

Both shapes require `id`. A transform's writes to `this` are committed, and
`args` is its params — omitting `args` means "run it with no params", because
scheduling the activity is itself the ask. (gqlize's `apply` input reads a falsy
value as "named but not asked for" only because it lists every exposed transform
at once.)

`expose.instanceMethods` defaults to **on** here, unlike nestize, where it is off
until you opt in. A definition with no `expose` block at all has every instance
method under the query gate, which is the pre-7.0 behaviour unchanged.

## Queue naming

`prefix + datasource + model`, joined by `queueSeparator`:

```
myapp.sqlite.Task
```

Override per-model with `queues: { Task: "legacy-tasks" }`, or wholesale with
`queueName: ({ model, datasource, definition }) => …`. Several models may share a
queue; that worker registers all of their activities.

## Context and permissions

`context` is opaque — temporalize never inspects it. It is passed verbatim to
`orm.runWithContext(context, …)`, so `definition.before`/`after` hooks see it
through `orm.getContext()`.

Supply `resolvePermission` to gate calls on it:

```ts
import { createRoleBasedPermissions } from "@azerothian/utilize";

createWorkers(orm, {
  resolvePermission: (context) => permissionForRole(context.role),
});
```

With a permission in play, temporalize refuses denied models (as an
unknown-model failure, so denial does not confirm the model exists), denied
mutations, denied class/instance methods and denied filter/order fields, and
strips denied fields from results. Return a **stable object per role** — the
generated Zod schemas are memoized by permission identity.

Without it, temporalize does no gating at all; it only propagates the context.

## Failures

Authorization, validation, unknown-model and unscoped-mutation errors throw
**non-retryable** `ApplicationFailure`s with a `type` from `ErrorType`
(`TemporalizeForbidden`, `TemporalizeValidation`, `TemporalizeUnknownModel`, …).
Retrying a `403` forever is the classic Temporal footgun. Transient adapter and
database errors are rethrown as-is, so your retry policy applies to them.

Temporal wraps failures rather than flattening them, so a client sees
`WorkflowFailedError` → `cause: ActivityFailure` → `cause: ApplicationFailure`:

```ts
try {
  await t.model("Task").create({ context, input });
} catch (e: any) {
  if (e.cause?.cause?.type === ErrorType.Forbidden) { /* … */ }
}
```

## Options

| Option              | Default   | Meaning                                                        |
| ------------------- | --------- | -------------------------------------------------------------- |
| `queuePrefix`       | —         | Prepended to every generated queue name.                        |
| `queueSeparator`    | `"."`     | Joins the queue name segments.                                  |
| `includeDatasource` | `true`    | Include the adapter name so cross-adapter models never collide. |
| `queues`            | —         | Per-model queue override.                                       |
| `queueName`         | —         | Full override of queue naming.                                  |
| `models`            | all       | Allow-list of models to generate for.                           |
| `resolvePermission` | —         | Derives the permission gate from the per-call context.          |
| `validate`          | `true`    | Validate `input` against the ormize-zod4 schemas.               |
| `readOnly`          | `false`   | Refuse every mutating activity. An instance method is mutating only when declared under `expose.instanceMethods.mutations`; `.query`-target and undeclared ones are reads and still run. |
| `transactional`     | `true`    | Wrap each mutating activity in `orm.transaction()`.             |
| `includeRelations`  | `true`    | Include relationship keys in activity results.                  |
| `expose`            | both on   | `{ classMethods?, instanceMethods? }`. `instanceMethods` covers both `expose` targets, each under its own gate — see [Activities](#activities). |

`createWorkers` adds `connection`, `namespace`, `workflowsPath`,
`workflowBundle`, `onlyQueues` and `workerOptions`. `createTemporalizeClient`
adds `workflowIdPrefix` and `workflowOptions`.

## Caveats

- **Activity retries are at-least-once.** A `create` that times out *after* the
  row was written will be retried and will duplicate it. Set
  `retry: { maximumAttempts: 1 }` for creates, or enforce an idempotency key with
  a unique constraint. temporalize does not deduplicate.
- **`transactional` spans one activity only.** Atomicity across several
  activities is a saga concern and remains the caller's job.
- **Prefer `bundleWorkflowCode`** over `workflowsPath` in production —
  `workflowsPath` bundles the workflow code at worker startup.
- `workflowsPath` is never inferred. Pass
  `require.resolve("@azerothian/temporalize/workflows")` explicitly.

## License

MIT
