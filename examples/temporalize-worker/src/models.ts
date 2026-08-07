import { DataTypes } from "sequelize";

/**
 * The same two-model domain the other examples use: an `Item` has many `Task`s.
 * These are plain ormize `Definition`s — temporalize turns each one into a set of
 * activities on its own task queue.
 *
 * `classMethods` / `instanceMethods` become activities too, so anything you can
 * call on a model in-process is reachable from a Temporal workflow.
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
  /**
   * Runs on every operation. `options.context` is the object the caller attached
   * to the activity input — temporalize put it in ormize's ambient store before
   * touching the engine, so identity is available this deep without threading it
   * through by hand.
   */
  before(options: any) {
    console.log(`  [orm] Item op as ${options.context?.userId ?? "anonymous"}`);
    return options.params;
  },
  classMethods: {
    async labelsUpper(this: any) {
      const rows = await this.findAll();
      return rows.map((r: any) => String(r.label || "").toUpperCase());
    },
  },
  instanceMethods: {
    async describe(this: any, args: any) {
      return `${this.label}${args?.suffix ?? ""}`;
    },
  },
};

export const TaskDef: any = {
  name: "Task",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    done: { type: DataTypes.BOOLEAN, defaultValue: false },
    // Foreign keys are excluded from mutation input by default (mass-assignment
    // / IDOR guard). Declare the belongsTo FK explicitly with `writable: true`
    // so a workflow can set it directly.
    itemId: { type: DataTypes.INTEGER, allowNull: true, writable: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};
