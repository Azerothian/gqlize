import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

const ItemDef: any = {
  name: "Item",
  define: {
    label: { type: DataTypes.STRING },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
};

const TaskDef: any = {
  name: "Task",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    done: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};

/** Build a fresh, initialised & synced in-memory ormize (Item hasMany Task). */
export async function buildOrm(): Promise<any> {
  const orm: any = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}
