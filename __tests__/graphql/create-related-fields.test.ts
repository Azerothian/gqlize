import Database from "../../src/manager";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";
import createRelatedFieldsFunc from "../../src/graphql/create-related-fields";
import {GraphQLObjectType} from "graphql";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { Definition } from '../../src/types';
import { GqlizeAdapter } from "../../src/types";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";
test("createRelatedFieldsFunc - empty define", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  })  as GqlizeAdapter, "sqlite");
  const itemDef = {
    name: "Item",
    define: {},
    relationships: [{
      model: "Item",
      type: "hasMany",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
      },
    }, {
      model: "Item",
      type: "belongsTo",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }],
  } as Definition;
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = new GraphQLObjectType({
    name: "Item",
    fields: {}
  });
  const func = createRelatedFieldsFunc("Item", db, itemDef, {}, schemaCache);
  expect(func).toBeInstanceOf(Function);
  const fields = func();
  expect(fields).toBeDefined();
  // expect(fields.id).toBeDefined();
  // expect(fields.id.type).toBeInstanceOf(GraphQLNonNull);
  // expect(fields.id.type.ofType).toEqual(GraphQLID);
});
