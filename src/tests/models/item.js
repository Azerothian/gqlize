import Sequelize from "sequelize";
import {GraphQLID} from "graphql";
import {toGlobalId} from "graphql-relay/lib/node/node";

export default {
  name: "Item",
  tableName: "items",
  define: {
    id: {type: Sequelize.UUID, allowNull: false, unique: true, primaryKey: true},
    name: {type: Sequelize.STRING, allowNull: false},
  },
  override: {
    id: {
      type: GraphQLID,
      output(result, args, context, info) {
        return toGlobalId("Item", result.id);
      },
      input(field, args, context, info) {
        return field;
      },
    },
  },
  relationships: [
    {type: "hasMany", model: "Item", name: "children", options: {as: "children", foreignKey: "parentId", sourceKey: "id"}},
    {type: "belongsTo", model: "Item", name: "parent", options: {as: "parent", foreignKey: "parentId", sourceKey: "id"}},
  ],
  options: {
    tableName: "items",
    hooks: {},
    classMethods: {},
    instanceMethods: {},
  },
};
