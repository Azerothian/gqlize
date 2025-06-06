import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";
import Database from "../../src/manager";
import createModelType from "../../src/graphql/create-model-type";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { GqlizeAdapter } from "../../src/types";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

test("createModelType", async() => {
  const db = new Database();
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
  //(defName, instance, options, nodeInterface, typeCollection, prefix = "")
  const schemaCache = createSchemaCache();
  const graphqlModel = await createModelType(itemDef.name, db, {}, {}, schemaCache, "");
  expect(graphqlModel).toBeDefined();
  expect(schemaCache.types.Item).toBeDefined();
  expect(schemaCache.types["Item[]"]).toBeDefined();
});
