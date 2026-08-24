import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import type { Definition } from "@azerothian/utilize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

const ItemDef: Definition = {
  name: "Item",
  define: {
    label: { type: DataTypes.STRING },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
};

const TaskDef: Definition = {
  name: "Task",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    done: { type: DataTypes.BOOLEAN, defaultValue: false },
    // Explicitly declare the belongsTo foreign key so it can opt in to being
    // client-writable. Foreign keys are excluded from mutation input by default
    // (mass-assignment / IDOR guard); `writable: true` re-enables setting it
    // directly on create/update (e.g. POST /task { name, itemId }).
    itemId: { type: DataTypes.INTEGER, allowNull: true, writable: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};

/** Build a fresh, initialised & synced in-memory ormize (Item hasMany Task). */
export async function buildOrm(): Promise<Ormize> {
  const orm = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}
