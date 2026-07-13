# gqlize-adapter-sequelize

This is a sequelize adapter for the graphql relational databinder [gqlize](https://github.com/azerothian/gqlize)

## Install

```sh
pnpm add @azerothian/gqlize @azerothian/gqlize-adapter-sequelize
```

Provide the peer dependencies in your project:

```sh
pnpm add graphql@^16.8.1 graphql-relay@^0.10.0 sequelize@^6.35.1
```

(`@azerothian/graphql-types` is pulled in automatically. See the [gqlize README](../gqlize/README.md#caveats) for the required `graphql` mutation patch.)

## License

This repository generally is covered by MIT unless specified


## TODO
- Setup Documentation
- phase out the remaining imports of graphql-sequelize
- change where/filter object for sequelize adapter to typed object 
- implement includes
- test if model has a defaultValue is a 0 value, it sets the field as autoPopulated
- Write more unit tests

## Contributers

- Mick Hansen (Not a direct contributor, but I used alot of his code from graphql-sequelize as a reference and blatantly copied some)
- Lousie Apostol
- Matthew Mckenzie
