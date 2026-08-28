import Sequelize from "sequelize";
import { Definition } from '../../../src/types';

/**
 * The shared fixture's soft-deleting model.
 *
 * `options.paranoid` gives it a `deletedAt` column, so a delete marks the row
 * rather than removing it — which is what puts a `deleted` argument on its list
 * fields and a `restore` argument on its mutation. The other four fixture models
 * hard-delete, so this is the only one that exercises either.
 *
 * The relationship is to itself so that a nested connection whose *target* soft
 * deletes exists without any of the other models having to know about this one.
 */
const memoDef: Definition = {
  name: "Memo",
  comment: "memo comment",
  define: {
    body: {type: Sequelize.STRING, allowNull: false},
    // Client-writable so a mutation can build a reply tree directly; foreign
    // keys are excluded from mutation input by default (mass-assignment guard).
    parentId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
  },
  relationships: [
    {type: "hasMany", model: "Memo", name: "replies", options: {as: "replies", foreignKey: "parentId"}},
    {type: "belongsTo", model: "Memo", name: "parent", options: {as: "parent", foreignKey: "parentId"}},
  ],
  options: {paranoid: true},
};

export default memoDef;
