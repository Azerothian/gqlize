import {graphql, GraphQLEnumType, GraphQLInputObjectType, GraphQLList, GraphQLObjectType} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "./helper";
import {createSchema} from "../src";
import type {Definition} from "../src/types/index";

// `ignoreFields` is documented as excluded from every generated type. Only the
// output type honoured it, so an "ignored" column stayed writable through the
// mutation inputs and filterable and sortable through `where`/`orderBy`.
const vault: Definition = {
  name: "Vault",
  define: {
    label: {type: Sequelize.STRING, allowNull: false},
    secret: {type: Sequelize.STRING, allowNull: true},
  },
  ignoreFields: ["secret"],
};

async function vaultSchema() {
  const instance = await createInstance([vault]);
  await instance.models.Vault.create({label: "a", secret: "s"});
  return createSchema(instance);
}

const fieldNames = (type: unknown) => Object.keys((type as GraphQLObjectType | GraphQLInputObjectType).getFields());

describe("ignoreFields", () => {
  it("is absent from the output type and both mutation inputs", async() => {
    const schema = await vaultSchema();
    expect(fieldNames(schema.getType("Vault"))).not.toContain("secret");
    expect(fieldNames(schema.getType("VaultRequiredInput"))).toEqual(expect.arrayContaining(["label"]));
    expect(fieldNames(schema.getType("VaultRequiredInput"))).not.toContain("secret");
    expect(fieldNames(schema.getType("VaultOptionalInput"))).not.toContain("secret");
  });

  it("cannot be filtered or sorted on", async() => {
    const schema = await vaultSchema();
    const list = (schema.getType("QueryModels") as GraphQLObjectType).getFields().Vault;
    const where = list.args.find((a) => a.name === "where")!.type as GraphQLInputObjectType;
    expect(fieldNames(where)).toEqual(expect.arrayContaining(["label"]));
    expect(fieldNames(where)).not.toContain("secret");
    const orderBy = (list.args.find((a) => a.name === "orderBy")!.type as GraphQLList<GraphQLEnumType>).ofType;
    const values = orderBy.getValues().map((v) => v.name);
    expect(values).toEqual(expect.arrayContaining(["labelASC"]));
    expect(values).not.toContain("secretASC");
  });

  it("rejects a mutation that writes it", async() => {
    const schema = await vaultSchema();
    const result = await graphql({schema, source: `mutation { models { Vault(create: {label: "b", secret: "x"}) { label } } }`});
    expect(result.errors?.[0]?.message).toMatch(/secret/);
  });
});
