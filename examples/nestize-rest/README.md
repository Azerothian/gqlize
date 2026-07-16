# nestize REST example

A minimal, **runnable** NestJS REST + Swagger API built from an
[`@azerothian/ormize`](../../packages/ormize) instance with
[`@azerothian/nestize`](../../packages/nestize). It defines two models (`Item` has many `Task`),
registers `NestizeModule.forRoot(orm)`, and serves generated CRUD + relationship routes over an
in-memory SQLite database, with an OpenAPI document at `/docs`.

The same `Item`/`Task` definitions are used by the [gqlize GraphQL example](../gqlize-basic) — the two
packages are different projections of one ormize instance.

## Run it

From the **repo root** (installs the whole workspace once):

```sh
pnpm install
```

Then start the app:

```sh
pnpm --filter @azerothian/example-nestize-rest start
# nestize example listening on http://localhost:3000  (Swagger UI: /docs)
```

- REST API root: <http://localhost:3000>
- Swagger UI: <http://localhost:3000/docs> — raw doc at `/docs-json`

Set `PORT` to change the port.

## How it wires together

| File | Responsibility |
| --- | --- |
| [`src/models.ts`](src/models.ts) | Two ormize `Definition`s (`Item`, `Task`) using Sequelize `DataType`s + a relationship. |
| [`src/orm.ts`](src/orm.ts) | `new Ormize()` → `registerAdapter(new SequelizeAdapter(...))` → `addDefinition()` → `initialise()` → `sync()`, then seeds rows. |
| [`src/main.ts`](src/main.ts) | `NestizeModule.forRoot(orm, options)` in an `@Module`, boot with `NestFactory`, `setupSwagger(app, orm, …)`. |

The whole projection is:

```ts
@Module({ imports: [NestizeModule.forRoot(orm, { includeRelations: true })] })
class AppModule {}

const app = await NestFactory.create(AppModule);
setupSwagger(app, orm, { title: "Nestize Example API", version: "1.0.0", path: "docs" });
await app.listen(3000);
```

## Routes & sample requests

Resource segments are the lower-cased model name (`/task`, `/item`). Request bodies are validated with
the model's `@azerothian/ormize-zod4` schema; a failure returns `400` with the Zod issues.

**Create** — `POST /task`
```sh
curl -X POST localhost:3000/task -H 'content-type: application/json' -d '{"name":"Buy bread"}'
# {"done":false,"id":3,"name":"Buy bread"}
```

**Validation error** — `POST /task` with a missing required field → `400`
```sh
curl -X POST localhost:3000/task -H 'content-type: application/json' -d '{}'
# {"statusCode":400,"message":"Validation failed","errors":[{"code":"invalid_type","path":["name"],...}]}
```

**List** — `GET /task` → `{ total, rows }`
```sh
curl localhost:3000/task
# {"total":2,"rows":[{"id":1,"name":"Buy milk","done":false,...}, ...]}
```

**Filter / order / paginate / count** (query string):
```sh
curl 'localhost:3000/task?filter={"done":{"eq":true}}'   # per-field operator DSL (JSON)
curl 'localhost:3000/task?order=-name'                    # `-` = DESC; also `name`, `nameASC`
curl 'localhost:3000/task?limit=10&offset=20'             # pagination
curl 'localhost:3000/task?count=only'                     # -> {"total":2}
```

**Fetch one** — `GET /task/:id` (`404` when missing)
```sh
curl localhost:3000/task/1
```

**Update matching rows** — `PATCH /task?filter=…`
```sh
curl -X PATCH 'localhost:3000/task?filter={"id":{"eq":1}}' \
  -H 'content-type: application/json' -d '{"done":true}'
# [{"id":1,"name":"Buy milk","done":true,...}]
```

**Delete matching rows** — `DELETE /task?filter=…`
```sh
curl -X DELETE 'localhost:3000/task?filter={"id":{"eq":2}}'
# {"deleted":[{"id":2,...}]}
```

**Relationship read** — `GET /item/:id/tasks` → single object for `belongsTo`/`hasOne`, else `{ total, rows }`
```sh
curl localhost:3000/item/1/tasks
```

Also available: `POST /:resource/:id/:relation` (associate), `DELETE /:resource/:id/:relation/:relId`
(disassociate), `POST /:resource/select`, and `_actions` routes for `classMethods`/`instanceMethods`
(enable via the `expose` option).

## `forRoot` options

```ts
NestizeModule.forRoot(orm, {
  permission,           // structural gate (see below) — denied models/fields 403/404
  pathPrefix: "api",    // -> /api/task
  includeRelations: true,  // default true; nested relation routes
  readOnly: false,      // default false; write verbs return 405 when true
  expose: { classMethods: true, instanceMethods: true },
});
```

`forRootAsync({ imports, inject, useFactory })` is also available when the ormize instance must be built
from other providers (e.g. a config service).

## Permissions

Pass a `permission` bag (same contract as gqlize). Structural gating only — models, fields,
relationships, mutations. Example denying `Task` creation:

```ts
import { createRoleBasedPermissions } from "@azerothian/utilize";

const permission = createRoleBasedPermissions(
  "user",
  { user: { model: "allow", mutationCreate: { Task: "deny" } } },
  { defaultDeny: false },
);
NestizeModule.forRoot(orm, { permission });
// POST /task -> 403
```

## Notes

- Runs the workspace packages **from source** via `@swc-node/register` — NestJS needs
  `emitDecoratorMetadata`, which swc emits (esbuild/`tsx` does not). The example pins its own
  TypeScript 5.x for the loader; the packages themselves are transformed by swc. In your own project
  you would `npm install @azerothian/nestize @azerothian/ormize @azerothian/ormize-zod4 @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/swagger reflect-metadata rxjs`
  plus an ormize adapter, and build with the Nest CLI / swc as usual.
- Suites/servers share a global Sequelize model registry, so run one app instance per process.

See the [`@azerothian/nestize` README](../../packages/nestize/README.md) for the full route table and
option reference.
