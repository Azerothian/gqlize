# @azerothian/gqlize-shared

Shared internal building blocks for the gqlize / ormize project:

- **Adapter contracts** — two-level interface split:
  - `OrmAdapter` (backend) — the GraphQL-free adapter contract consumed by `@azerothian/ormize`.
  - `GqlizeAdapter extends OrmAdapter` (graphql extension, at
    `@azerothian/gqlize-shared/types/gqlize-adapter`) — adds type-mapping, filter, and eager-load
    methods consumed by `@azerothian/gqlize`. The Sequelize adapter implements this interface.
- **Type surface** (`@azerothian/gqlize-shared/types/index`) — model/field definitions
  (`Definition`, `DefinitionOptions`, `DefinitionField*`, `Association`, `Relationship`,
  `WhereOperators`, …), and options/cache types.
- **`Events`** (`@azerothian/gqlize-shared/events`) — the lifecycle hook event enum.
- **Utilities** (`@azerothian/gqlize-shared/utils/*`) — `logger`, `unique`, `word`
  (`capitalize`/`lowecase`), and `waterfall`/`waterfallSync`.

This package is consumed by `@azerothian/ormize` (backend manager), `@azerothian/gqlize`
(GraphQL layer), and `@azerothian/ormize-adapter-sequelize`. It exists to single-source types
previously duplicated. It is published so those packages remain installable standalone.

## License

MIT
