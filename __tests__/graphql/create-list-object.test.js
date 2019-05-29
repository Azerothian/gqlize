import Database from "../../src/manager";
import SequelizeAdapter from "@vostro/gqlize-adapter-sequelize";
import createModelType from "../../src/graphql/create-model-type";
import createListObject from "../../src/graphql/create-list-object";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import createNodeInterface from "../../src/graphql/utils/create-node-interface";
import {
  GraphQLID,
  GraphQLNonNull,
  GraphQLString,
  GraphQLObjectType,
} from "graphql";
import Sequelize from "sequelize";

test("createListObject", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
  const itemDef = {
    name: "Item",
    define: {},
    relationships: []
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  const {nodeInterface} = createNodeInterface(db);
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = createModelType(itemDef.name, db, {}, nodeInterface, schemaCache);
  //(instance, schemaCache, targetDefName, targetType, resolveData, prefix = "", suffix = "")
  const listObject = createListObject(db, schemaCache, itemDef.name, schemaCache.types.Item, "", "");
  expect(listObject.type).toBeInstanceOf(GraphQLObjectType);

  // expect(basicFieldsFunc).toBeInstanceOf(Function);
  // const fields = basicFieldsFunc();
  // expect(fields).toBeDefined();
  // expect(fields.id).toBeDefined();
  // expect(fields.id.type).toBeInstanceOf(GraphQLNonNull);
  // expect(fields.id.type.ofType).toEqual(GraphQLID);
});

