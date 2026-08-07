import { Ormize } from "@azerothian/ormize";
import GqlizeBinding from "../../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import createModelType from "../../src/graphql/create-model-type";
import createListObject from "../../src/graphql/create-list-object";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import createNodeInterface from "../../src/graphql/utils/create-node-interface";
import {GraphQLObjectType} from "graphql";
import { GqlizeAdapter } from '../../src/types/index';
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";


test("createListObject", async() => {
  const db = new GqlizeBinding(new Ormize());
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  const itemDef = {
    name: "Item",
    define: {},
    relationships: []
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const {nodeInterface} = createNodeInterface(db);
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = createModelType(itemDef.name, db, {}, nodeInterface, schemaCache);
  //(instance, schemaCache, targetDefName, targetType, data, prefix = "", suffix = "")
  const listObject = createListObject(db, schemaCache, itemDef.name, schemaCache.types.Item, {
    source: "findAll",
    defName: itemDef.name,
  }, "", "");
  expect(listObject.type).toBeInstanceOf(GraphQLObjectType);
  expect(listObject.resolve).toBeInstanceOf(Function);
  expect(listObject.extensions.gqlize).toEqual({
    kind: "connection",
    connectionName: "Item",
    targetDefName: "Item",
    data: {source: "findAll", defName: "Item"},
  });

  // expect(basicFieldsFunc).toBeInstanceOf(Function);
  // const fields = basicFieldsFunc();
  // expect(fields).toBeDefined();
  // expect(fields.id).toBeDefined();
  // expect(fields.id.type).toBeInstanceOf(GraphQLNonNull);
  // expect(fields.id.type.ofType).toEqual(GraphQLID);
});

