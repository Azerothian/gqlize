import { DataTypes } from "sequelize";

/**
 * A tiny two-model domain: an `Item` has many `Task`s; a `Task` belongs to an
 * `Item`. These are plain ormize `Definition`s — the same shape gqlize consumes.
 * `nestize` turns each definition into a set of REST routes + Swagger schemas.
 */

export const ItemDef: any = {
  name: "Item",
  define: {
    label: { type: DataTypes.STRING, allowNull: false },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
};

export const TaskDef: any = {
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
