import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { ItemDef, TaskDef } from "./models";

/**
 * Build a fresh, initialised + synced ormize instance backed by an in-memory
 * SQLite database, then seed a couple of rows so the REST routes return data
 * immediately. This is identical to how you would wire ormize for gqlize —
 * nestize is just a different projection of the same instance.
 */
export async function buildOrm(): Promise<any> {
  const orm: any = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");

  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);

  await orm.initialise();
  await orm.sync();

  // Seed data
  const groceries = await orm.models.Item.create({ label: "Groceries" });
  await orm.models.Task.create({ name: "Buy milk", itemId: groceries.id });
  await orm.models.Task.create({ name: "Buy eggs", itemId: groceries.id, done: true });

  return orm;
}
