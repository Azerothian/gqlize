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
  options: {
    timestamps: false,
    // Both `expose.instanceMethods` targets resolve to this one namespace — that
    // is the whole reason the `_actions` route has to look at `expose` to tell a
    // read from a write.
    instanceMethods: {
      /** Declared under `expose.instanceMethods.query`: reads, returns, writes nothing. */
      describe(this: { name: string }) {
        return `task:${this.name}`;
      },
      /** Declared under `expose.instanceMethods.mutations`: a pre-commit transform. */
      appendSuffix(this: { name: string }, params?: { suffix?: string }) {
        this.name = `${this.name}${params?.suffix ?? "!"}`;
      },
      /** A transform that returns values to merge rather than assigning to `this`. */
      rename(_params?: { to?: string }) {
        return { name: "renamed" };
      },
      /** Declared under neither target — reachable, and still read-only. */
      undeclared(this: { name: string }) {
        return `undeclared:${this.name}`;
      },
    },
  },
  expose: {
    instanceMethods: {
      query: { describe: { type: DataTypes.STRING } },
      mutations: { appendSuffix: {}, rename: {} },
    },
  },
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
