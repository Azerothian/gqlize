# @azerothian/graphql-types

Custom GraphQL scalar types and helpers used by
[gqlize](https://github.com/azerothian/gqlize). A local copy of
[`@vostro/graphql-types`](https://github.com/VostroNet/graphql-types).

Subpath exports (import the piece you need):

- `@azerothian/graphql-types/json` — a `JSON` scalar
- `@azerothian/graphql-types/date` — a `Date` scalar
- `@azerothian/graphql-types/bigint` — a `BigInt` scalar
- `@azerothian/graphql-types/float` — the `Float` scalar
- `@azerothian/graphql-types/ip` — an `IP` scalar
- `@azerothian/graphql-types/upload` — an `Upload` scalar
- `@azerothian/graphql-types/query` — `createQueryType(config)` + `defaultConfig`

`graphql` is a peer dependency (`^17.0.0`).

## License

MIT
