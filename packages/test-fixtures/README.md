# @azerothian/test-fixtures

The model definitions the `ormize` and `gqlize` test suites both build against.

**Private — never published.** It exists so one set of models is exercised by both
the engine's tests and the schema builder's, rather than two copies drifting.

The `ormize-adapter-sequelize` suite deliberately keeps its own copies: those are
typed against `SequelizeDefinition` rather than `Definition`, which is the thing
they are there to test.
