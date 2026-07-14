import {graphql} from "graphql";
import Sequelize from "sequelize";
import Database from "../src/manager";
import {createSchema} from "../src/graphql/index";
import {validateResult} from "./helper";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";

describe("include type for leaf relationship targets", () => {
  it("builds a schema (and queries) when a relation target has no relationships", async () => {
    const db = new Database();
    const {adapter, name, teardown} = await createAdapterForDialect();
    registerTeardown(teardown);
    db.registerAdapter(adapter, name);

    // Leaf has no relationships of its own -> no include type. `Root.leaf` (belongsTo)
    // previously produced `include: { type: undefined }` and crashed createSchema.
    db.addDefinition({name: "Leaf", define: {name: {type: Sequelize.STRING, allowNull: false}}} as any);
    db.addDefinition({
      name: "Root",
      define: {title: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsTo", model: "Leaf", name: "leaf", options: {foreignKey: "leafId"}}],
    } as any);
    await db.initialise();
    await db.sync();

    const schema = await createSchema(db); // must not throw
    const {Root, Leaf} = db.models as any;
    const leaf = await Leaf.create({name: "leaf1"});
    await Root.create({title: "root1", leafId: leaf.get("id")});

    const result = (await graphql({
      schema,
      source: `query { models { Root { edges { node { title leaf { name } } } } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.Root.edges[0].node.leaf.name).toEqual("leaf1");
  });
});
