# @azerothian/nestize

Generate a [NestJS](https://nestjs.com) REST API + Swagger/OpenAPI from an
[`@azerothian/ormize`](../ormize) instance — the REST analogue of
[`@azerothian/gqlize`](../gqlize) (GraphQL). No GraphQL dependency: it drives the
same graphql-free ormize resolution engine that gqlize uses, so REST and GraphQL
share resolution, filtering, relationships and permission rules.

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
| `GET`   | `/:resource/:id/:relation`             | fetch a relationship                |
| `POST`  | `/:resource/:id/:relation`             | relationship mutation               |
| `DELETE`| `/:resource/:id/:relation/:relId`      | disassociate a related record       |
| `GET`   | `/:resource/_actions/:method`          | class-method query                  |
| `POST`  | `/:resource/_actions/:method`          | class-method mutation               |
| `POST`  | `/:resource/:id/_actions/:method`      | instance-method call                |

`:resource` is the lower-cased (or exact) model name. The filter DSL is the same
per-field operator object gqlize uses (`{ field: { eq, in, like, gte, … } }` with
`and`/`or` composition).

## Options (`NestizeModule.forRoot(orm, options)`)

| Option             | Default | Meaning                                                    |
| ------------------ | ------- | ---------------------------------------------------------- |
| `permission`       | —       | Permission object (`createRoleBasedPermissions`) gating models/fields/relationships/mutations. |
| `pathPrefix`       | —       | Prefix applied to every route (e.g. `api`).                |
| `includeRelations` | `true`  | Expose nested relationship routes.                         |
| `readOnly`         | `false` | Only allow reads; writes return `405`.                     |
| `expose`           | —       | `{ classMethods?, instanceMethods? }` — expose `_actions` routes. |

## License

MIT
