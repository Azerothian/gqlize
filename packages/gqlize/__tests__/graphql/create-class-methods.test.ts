import { Ormize as Database } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { createClassMethodFields } from "../../src/graphql/create-class-methods";
import GqlizeBinding from "../../src/manager";
import {GraphQLObjectType, GraphQLInt} from "graphql";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { Definition } from '../../src/types';
import {test, expect} from "@jest/globals";

test("createClassMethodFields - mutations before/after hooks", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
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
  // The builders take the binding, not the raw backend — it is a transparent
  // wrapper, so this is the same object the live schema build passes.
  const fields = await createClassMethodFields(new GqlizeBinding(db), itemDef.name || "", itemDef, mutations, {}, schemaCache, "mutations");
  const result = await fields.testClassMethod.resolve({}, {amount: 1}, {}, {});
  expect(result).toEqual(102);
});
