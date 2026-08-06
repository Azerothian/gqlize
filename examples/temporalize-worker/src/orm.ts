import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { ItemDef, TaskDef } from "./models";

/**
 * A fresh, initialised + synced ormize instance backed by in-memory SQLite.
 *
 * This is identical to how you would wire ormize for gqlize or nestize —
 * temporalize is just a different projection of the same instance. Only the
 * worker process needs it; the client does not.
 *
 * In-memory means the data lives as long as the worker does, which is fine for a
 * demo but is exactly the sort of thing durable execution assumes is *not* true:
 * point the adapter at a real database before drawing conclusions about retries.
 */
export async function buildOrm(): Promise<any> {
  const orm: any = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");

  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);

  await orm.initialise();
  await orm.sync();

  return orm;
}
