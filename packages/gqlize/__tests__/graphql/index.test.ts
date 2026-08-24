import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import createModelType from "../../src/graphql/create-model-type";
import GqlizeBinding from "../../src/manager";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import {test,expect} from "@jest/globals";

test("createModelType", async() => {
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
  await db.sync();
  //(defName, instance, options, nodeInterface, typeCollection, prefix = "")
  const schemaCache = createSchemaCache();
  const graphqlModel = await createModelType(itemDef.name, new GqlizeBinding(db), {}, {}, schemaCache, "");
  expect(graphqlModel).toBeDefined();
  expect(schemaCache.types.Item).toBeDefined();
  expect(schemaCache.types["Item[]"]).toBeDefined();
});
