// A relationship whose target has no GraphQL type cannot become a field. When
// the omission is deliberate that is how permissions propagate; when the target
// has no definition at all it is an authoring mistake, and used to produce a
// schema quietly missing a field with no diagnostic anywhere. See #14.
import Sequelize from "sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import { describe, it, expect, jest, afterEach } from "@jest/globals";

import { createSchema } from "../src";
import type GQLManager from "../src/manager";
import type { Definition, SchemaCache } from "../src/types";
import createRelatedFieldsFunc from "../src/graphql/create-related-fields";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

async function createInstance(definitions: Definition[]) {
  const db = new Database();
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  for (const definition of definitions) {
    await db.addDefinition({ options: { timestamps: false }, ...definition });
  }
  await db.initialise();
  await db.sync();
  return db;
}

const branch = {
  name: "Branch",
  define: { code: { type: Sequelize.STRING, primaryKey: true } },
  relationships: [{
    type: "hasMany", model: "Leaf", name: "leaves",
    options: { as: "leaves", foreignKey: "branchCode" },
  }],
};
const leaf = {
  name: "Leaf",
  define: {
    code: { type: Sequelize.STRING, primaryKey: true },
    branchCode: { type: Sequelize.STRING },
  },
};

describe("relationships with no target type", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it("warns when the target has no definition", () => {
    // Driven directly rather than through `createSchema`: the condition is a
    // target gqlize was never given, and faking that on a live instance breaks
    // the adapter's own field resolution long before the schema builder runs.
    const instance = {
      getAssociations: () => ({
        leaves: { name: "leaves", target: "Leaf", source: "Branch", associationType: "hasMany" },
      }),
      getDefinition: () => undefined,
    } as unknown as GQLManager;
    const schemaCache = { relatedFields: {}, types: { Branch: {} } } as unknown as SchemaCache;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const fields = createRelatedFieldsFunc("Branch", instance, branch, {}, schemaCache)();

    expect(fields.leaves).not.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      "relationship 'Branch.leaves' targets 'Leaf', which has no definition"));
  });

  it("stays silent when the target type was omitted on purpose", async() => {
    const instance = await createInstance([branch, leaf]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    // `Leaf` has a definition; `permission.model` is what drops its type, and the
    // dropped relationship is how that denial is meant to propagate.
    const schema = await createSchema(instance, {
      permission: { model: (modelName: string) => modelName !== "Leaf" },
    });

    expect(schema.getType("Leaf")).not.toBeDefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("has no definition"));
  });
});
