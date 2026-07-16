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
    // Foreign keys are excluded from mutation input by default (mass-assignment
    // / IDOR guard). Declare the belongsTo FK explicitly with `writable: true`
    // so it can be set directly, e.g. POST /task { "name": "x", "itemId": 1 }.
    itemId: { type: DataTypes.INTEGER, allowNull: true, writable: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};
