import Sequelize from "sequelize";
import type { Definition } from "@azerothian/gqlize/types";

/**
 * A tiny two-model domain: an `Item` has many `Task`s; a `Task` belongs to an
 * `Item`. These are plain ormize `Definition`s — the exact same definitions
 * `@azerothian/nestize` consumes for REST. `createSchema` turns each one into a
 * Relay GraphQL type with a connection, CRUD mutations, and node() lookup.
 */

export const ItemDef = {
  name: "Item",
  define: {
    label: { type: Sequelize.STRING, allowNull: false },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
} as Definition;

export const TaskDef = {
  name: "Task",
  define: {
    name: { type: Sequelize.STRING, allowNull: false },
    done: { type: Sequelize.BOOLEAN, defaultValue: false },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
} as Definition;
