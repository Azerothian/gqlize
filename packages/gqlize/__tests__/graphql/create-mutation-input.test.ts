import { Ormize } from "@azerothian/ormize";
import GqlizeBinding from "../../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import createMutationInput from "../../src/graphql/create-mutation-input";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { GqlizeAdapter } from "../../src/types";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

test("createMutationInput", async() => {
  const db = new GqlizeBinding(new Ormize());
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  const itemDef = {
    name: "Item",
    define: {
      test: {
        type: Sequelize.INTEGER,
      },
    },
    relationships: [],
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const inputTypes = {};
  const schemaCache = createSchemaCache();
  // `mutableDefNames` is which models can contribute a relationship input;
  // the live build derives it from the permission-visible set.
  const result = createMutationInput(new GqlizeBinding(db), "Item", schemaCache, inputTypes, {}, new Set(["Item"]));
  expect(result).toBeDefined();
  expect(result.required).toBeDefined();
  expect(result.optional).toBeDefined();
  expect(result.create).toBeDefined();
  expect(result.update).toBeDefined();
  expect(result.delete).toBeDefined();
});
