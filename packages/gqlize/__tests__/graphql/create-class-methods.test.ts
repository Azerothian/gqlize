import Database from "../../src/manager";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";
import { createClassMethodFields } from "../../src/graphql/create-class-methods";
import {GraphQLObjectType, GraphQLInt} from "graphql";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { Definition, GqlizeAdapter } from '../../src/types';
import {test, expect} from "@jest/globals";

test("createClassMethodFields - mutations before/after hooks", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  const itemDef = {
    name: "Item",
    define: {},
    relationships: [],
    expose: {
      classMethods: {
        mutations: {
          testClassMethod: {
            type: GraphQLInt,
            before(args: any, context: any) {
              return {
                ...args,
                amount: args.amount + 1,
              };
            },
            after(result: any, context: any) {
              return result + 100;
            },
          },
        },
      },
    },
    options: {
      classMethods: {
        testClassMethod(args: any) {
          return args.amount;
        },
      },
    },
  } as Definition;
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = new GraphQLObjectType({
    name: "Item",
    fields: {}
  });
  const mutations = itemDef.expose?.classMethods?.mutations || {};
  const fields = await createClassMethodFields(db, itemDef.name || "", itemDef, mutations, {}, schemaCache, "mutations");
  const result = await fields.testClassMethod.resolve({}, {amount: 1}, {}, {});
  expect(result).toEqual(102);
});
