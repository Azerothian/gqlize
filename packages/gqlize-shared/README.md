# @azerothian/gqlize-shared

Shared internal building blocks for [gqlize](https://github.com/azerothian/gqlize):

- **Type surface** (`@azerothian/gqlize-shared/types/index`) — the adapter contract
  (`GqlizeAdapter`), model/field definitions (`Definition`, `DefinitionOptions`,
  `DefinitionField*`, `Association`, `Relationship`, `WhereOperators`, …), and options/cache types.
- **`Events`** (`@azerothian/gqlize-shared/events`) — the lifecycle hook event enum.
- **Utilities** (`@azerothian/gqlize-shared/utils/*`) — `logger`, `unique`, `word`
  (`capitalize`/`lowecase`), and `waterfall`/`waterfallSync`.

This package is consumed by `@azerothian/gqlize` (core) and
`@azerothian/gqlize-adapter-sequelize`. It exists to single-source the code both previously
duplicated. It is published so those packages remain installable standalone.

## License

GPL-3.0
