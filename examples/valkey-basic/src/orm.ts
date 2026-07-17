import { Ormize } from "@azerothian/ormize";
import ValkeyAdapter from "@azerothian/ormize-adapter-valkey";
import { DataTypes } from "@azerothian/utilize/types/data-type";

/**
 * A tiny domain on Valkey: an `Item` (indexed `label`) has many `Task`s; a `Task`
 * belongs to an `Item` via the `itemId` foreign key (auto-indexed, so the
 * relationship read is index-driven — no keyspace scan).
 */
export async function buildOrm(client: any): Promise<any> {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix: "demo" }, client), "valkey");

  await orm.addDefinition({
    name: "Item",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      label: { type: DataTypes.String, index: true },  // secondary index
      sku: { type: DataTypes.String, unique: true },    // unique index
    },
    options: {},
    relationships: [{ type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } }],
  });

  await orm.addDefinition({
    name: "Task",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.String },
    },
    options: {},
    relationships: [{ type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } }],
  });

  await orm.initialise();
  await orm.sync();
  return orm;
}
