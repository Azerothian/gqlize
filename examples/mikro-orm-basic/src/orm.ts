import { MikroORM } from "@mikro-orm/sqlite";
import { Ormize } from "@azerothian/ormize";
import MikroAdapter from "@azerothian/ormize-adapter-mikro-orm";
import { entities, type Entities } from "./entities";

/**
 * A live instance: MikroORM connected to in-memory SQLite, the schema created,
 * and a couple of rows seeded. `createSchema(orm)` (see server.ts) projects it
 * to a GraphQL schema.
 *
 * Note what is *not* here: no ormize definition is written anywhere in this
 * example. `registerAdapter` plus `initialise()` is the whole setup — the models
 * come out of the MikroORM instance's own metadata.
 */
export async function buildOrm() {
  const mikro = await MikroORM.init({ entities, dbName: ":memory:", allowGlobalContext: true });

  // `manageSchema` is what lets `initialise()` create the tables. It is off by
  // default: the instance belongs to the application, and an ormize call must
  // not issue DDL under it unasked. A throwaway in-memory database is exactly
  // the case that wants it on.
  const orm = new Ormize()
    .registerAdapter(new MikroAdapter<Entities>(mikro, { manageSchema: true }));

  await orm.initialise();

  const groceries = await orm.models.Item.create({ label: "Groceries" });
  await orm.models.Task.create({ name: "Buy milk", itemId: groceries.id });
  await orm.models.Task.create({ name: "Buy eggs", itemId: groceries.id, done: true });

  return orm;
}

/**
 * The same models, wired up in memory and no further — no connection, no
 * tables, no rows.
 *
 * MikroORM's synchronous constructor discovers entities without connecting, and
 * this adapter's discovery reads that metadata and opens nothing, so this is
 * enough for `createSchema`. It is deliberately *not* enough to serve a request.
 * `gqlize.config.ts` points here, which is what lets `pnpm schema:check` run as
 * a CI drift gate on a runner with no database at all.
 */
export async function buildOrmForSchema() {
  const mikro = new MikroORM({ entities, dbName: ":memory:", allowGlobalContext: true });
  const orm = new Ormize().registerAdapter(new MikroAdapter<Entities>(mikro));
  await orm.initialise({ ddl: false });
  return orm;
}
