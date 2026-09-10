import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { ItemDef, TaskDef } from "./models";

/**
 * Build a fresh, initialised + synced ormize instance backed by in-memory
 * SQLite, seeded with a couple of rows. `createSchema(orm)` (see server.ts)
 * projects this instance to a GraphQL schema.
 */
export async function buildOrm(): Promise<any> {
  const orm = await registerDefinitions();

  await orm.initialise();
  await orm.sync();

  // Seed data
  const groceries = await orm.models.Item.create({ label: "Groceries" });
  await orm.models.Task.create({ name: "Buy milk", itemId: groceries.id });
  await orm.models.Task.create({ name: "Buy eggs", itemId: groceries.id, done: true });

  return orm;
}

/**
 * The same definitions, wired up in memory and no further: no `sync()`, no seed
 * rows, and — because nothing here opens a connection — no database.
 *
 * That is enough for `createSchema`, which reads model metadata (attributes,
 * associations, `paranoid`) and never queries. It is deliberately *not* enough
 * to serve a request: the tables were never created. `gqlize.config.ts` uses
 * this, which is what lets `pnpm schema:check` run as a CI drift gate on a
 * runner with no database service.
 *
 * `initialise({ddl: false})` matters only for definitions carrying raw
 * create/drop DDL in `queries` — neither of these two does, but the flag is what
 * makes the guarantee hold for definitions that grow one later.
 */
export async function buildOrmForSchema(): Promise<any> {
  const orm = await registerDefinitions();
  await orm.initialise({ ddl: false });
  return orm;
}

/** The half both factories share: an adapter and the model definitions. */
async function registerDefinitions(): Promise<any> {
  const orm: any = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");

  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);

  return orm;
}
