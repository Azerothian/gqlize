# @azerothian/nestize

Generate a [NestJS](https://nestjs.com) REST API + Swagger/OpenAPI from an
[`@azerothian/ormize`](../ormize) instance — the REST analogue of
[`@azerothian/gqlize`](../gqlize) (GraphQL). No GraphQL dependency: it drives the
same graphql-free ormize resolution engine that gqlize uses, so REST and GraphQL
share resolution, filtering, relationships and permission rules.

> **Runnable example:** [`examples/nestize-rest`](../../examples/nestize-rest) — a complete NestJS app
> (models → ormize → `forRoot` → Swagger) you can start with
> `pnpm --filter @azerothian/example-nestize-rest start`, including `curl` recipes for every route.

## Install

```sh
npm install @azerothian/nestize @azerothian/ormize @azerothian/ormize-zod4 \
  @nestjs/common @nestjs/core @nestjs/swagger reflect-metadata rxjs
```

## Usage

```ts
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { NestizeModule, setupSwagger } from "@azerothian/nestize";
import { buildOrm } from "./orm"; // your initialised ormize instance

@Module({ imports: [NestizeModule.forRoot(await buildOrm())] })
class AppModule {}

const app = await NestFactory.create(AppModule);
setupSwagger(app, orm, { path: "docs" });
await app.listen(3000);
```

### `forRootAsync`

```ts
NestizeModule.forRootAsync({
  inject: [OrmProvider],
  useFactory: async (p: OrmProvider) => ({ orm: await p.get(), options: { permission } }),
});
```

## Routes

| Method  | Path                                   | Action                              |
| ------- | -------------------------------------- | ----------------------------------- |
| `GET`   | `/:resource`                           | list (`?filter`, `?order`, `?limit`, `?offset`, `?count`) |
| `GET`   | `/:resource/:id`                       | fetch one                           |
| `POST`  | `/:resource`                           | create                              |
| `PATCH` | `/:resource?filter=…`                  | update matching rows                |
| `DELETE`| `/:resource?filter=…`                  | delete matching rows                |
| `POST`  | `/:resource/select`                    | select + relationship sub-mutations |
| `POST`  | `/:resource/_csv/:operation`           | CSV create / update / delete ([below](#csv-uploads)) |
| `GET`   | `/:resource/:id/:relation`             | fetch a relationship                |
| `POST`  | `/:resource/:id/:relation`             | relationship mutation               |
| `DELETE`| `/:resource/:id/:relation/:relId`      | disassociate a related record       |
| `GET`   | `/:resource/_actions/:method`          | class-method query                  |
| `POST`  | `/:resource/_actions/:method`          | class-method mutation               |
| `POST`  | `/:resource/:id/_actions/:method`      | instance-method call                |

`:resource` is the lower-cased (or exact) model name. The filter DSL is the same
per-field operator object gqlize uses (`{ field: { eq, in, like, gte, … } }` with
`and`/`or` composition).

**`_actions` and `instanceMethods`.** The instance-method route enumerates the *implementations*
under `options.instanceMethods` — one namespace shared by both `expose` targets — so every declared
method has a route. Which `expose` target named it decides how the route behaves:

| Declared under | Gate | Behaviour | Response |
| --- | --- | --- | --- |
| `expose.instanceMethods.mutations` | `permission.mutationInstanceMethods`, **and** the model's `mutationUpdate` gate | run as a pre-commit transform through `processUpdate` with an empty input and an `apply` bag — the same path gqlize's `apply` argument takes, so it gets the transaction, the recording proxy and scope enforcement | the persisted row |
| `expose.instanceMethods.query`, or neither target | `permission.queryInstanceMethods` | load the row by primary key and call the method | whatever the method returned |

A transform's writes to `this` are committed, and the request body is its params
— an absent or empty body means "run it with no params", because calling the
route is itself the ask. (gqlize's `apply` input reads a falsy value as "named
but not asked for" only because it lists every exposed transform at once.)

`expose.instanceMethods` defaults to **off** here; temporalize defaults it on.
Nothing is reachable over REST until you opt in.

## CSV uploads

With CSV turned on for the ormize instance (`new Ormize({ csv: true })`, see the
[guide](../../docs/guide.md#csv-uploads)), `POST /:resource/_csv/create`, `…/update` and `…/delete`
apply a CSV body as one write per data row, all-or-nothing:

```sh
curl -X POST http://localhost:3000/task/_csv/create -H 'content-type: text/csv' --data-binary @tasks.csv
curl -X POST 'http://localhost:3000/task/_csv/update?keys=name' -H 'content-type: text/csv' --data-binary @done.csv
```

- **Body.** Send it as `text/csv`. Nest's default parsers leave that type unread, so the route
  streams the request itself. A body another parser already read (`express.text()`, a raw
  parser) and a multer `FileInterceptor` file (`req.file`) also work. Under Fastify, register a
  content-type parser for `text/csv`.
- **Rows.** The header names the fields. Cells are converted by column type (numbers, `true`/`false`,
  dates, JSON) and then validated by the same zod schema as `POST /:resource` (create) or
  `PATCH /:resource` (update). An empty cell is left out, and `\N` is null.
- **Matching.** `update` and `delete` match rows on the primary key, or on `?keys=a,b`. Matching on a
  field is held to the same filter permission as `?filter=`. `delete` takes only key columns.
- **Query.** `?delimiter=;` changes the separator.
- **Response.** `200 { rows }`. A refused file or row is `400 { code, message, row?, column? }` and
  nothing is written. Over the instance's row or byte limit is `413`. The route is a `404` for a model
  without CSV, and a `403` when the operation's permission or `permission.mutationCsv` denies it.

## Options (`NestizeModule.forRoot(orm, options)`)

| Option             | Default | Meaning                                                    |
| ------------------ | ------- | ---------------------------------------------------------- |
| `permission`       | —       | Permission object (`createRoleBasedPermissions`) gating models/fields/relationships/mutations. |
| `pathPrefix`       | —       | Prefix applied to every route (e.g. `api`).                |
| `includeRelations` | `true`  | Expose nested relationship routes.                         |
| `readOnly`         | `false` | Only allow reads; writes return `405`. An `_actions` instance method counts as a write only when declared under `expose.instanceMethods.mutations`. |
| `expose`           | —       | `{ classMethods?, instanceMethods? }` — expose `_actions` routes. Off by default. |

## License

MIT
