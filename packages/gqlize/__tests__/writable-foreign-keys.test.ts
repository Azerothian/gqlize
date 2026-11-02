import {graphql, GraphQLInputObjectType} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect} from "@jest/globals";
import {Ormize} from "@azerothian/ormize";

import {registerDialectAdapter} from "./helper/dialect";
import {resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import type {Definition} from "../src/types/index";

// `writableForeignKeys` puts back the 6.x behaviour of every foreign key being
// mutation input, without a `writable: true` on each column. It is applied in
// `orm.getFields`, so the schema and the runtime mass-assignment guard have to
// agree: a key that is on the input type but dropped by `processInputs` would
// be accepted and silently ignored.
const role: Definition = {
  name: "Role",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
  },
};
const user: Definition = {
  name: "User",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
    // Authored explicitly so `writable: false` has somewhere to sit.
    tenantId: {type: Sequelize.INTEGER, allowNull: true, writable: false},
  },
  relationships: [
    {type: "belongsTo", model: "Role", name: "role", options: {foreignKey: "roleId"}},
    {type: "belongsTo", model: "Role", name: "tenant", options: {foreignKey: "tenantId"}},
  ],
};

async function build(writableForeignKeys?: boolean) {
  const db = new Ormize({writableForeignKeys});
  await registerDialectAdapter(db);
  await db.addDefinition(role);
  await db.addDefinition(user);
  await db.initialise();
  await db.sync();
  return {db, schema: await createSchema(db)};
}

const inputFields = (schema: Awaited<ReturnType<typeof build>>["schema"], name: string) =>
  Object.keys((schema.getType(name) as GraphQLInputObjectType).getFields());

describe("writableForeignKeys", () => {
  it("keeps foreign keys out of mutation input by default", async() => {
    const {schema} = await build();
    expect(inputFields(schema, "UserRequiredInput")).not.toContain("roleId");
    expect(inputFields(schema, "UserOptionalInput")).not.toContain("roleId");
  });

  it("exposes foreign keys on both inputs when enabled", async() => {
    const {schema} = await build(true);
    expect(inputFields(schema, "UserRequiredInput")).toContain("roleId");
    expect(inputFields(schema, "UserOptionalInput")).toContain("roleId");
  });

  it("leaves primary keys and `writable: false` columns guarded", async() => {
    const {schema} = await build(true);
    expect(inputFields(schema, "UserRequiredInput")).not.toContain("id");
    expect(inputFields(schema, "UserRequiredInput")).not.toContain("tenantId");
    expect(inputFields(schema, "UserOptionalInput")).not.toContain("tenantId");
  });

  it("writes the foreign key from a global id on create and update", async() => {
    const {schema} = await build(true);
    const roles = await graphql({schema, source: `mutation {
      models { Role(create: [{name: "admin"}, {name: "user"}]) { id } }
    }`});
    validateResult(roles);
    const [admin, member] = resultData<{models: {Role: {id: string}[]}}>(roles).models.Role;

    const created = await graphql({
      schema,
      source: `mutation ($roleId: ID) { models { User(create: {name: "ada", roleId: $roleId}) { id roleId role { id } } } }`,
      variableValues: {roleId: admin.id},
    });
    validateResult(created);
    const [ada] = resultData<{models: {User: {id: string; roleId: string; role: {id: string}}[]}}>(created).models.User;
    expect(ada.roleId).toBe(admin.id);
    expect(ada.role.id).toBe(admin.id);

    const updated = await graphql({
      schema,
      source: `mutation ($id: ID, $roleId: ID) {
        models { User(update: {where: {id: {eq: $id}}, input: {roleId: $roleId}}) { roleId } }
      }`,
      variableValues: {id: ada.id, roleId: member.id},
    });
    validateResult(updated);
    expect(resultData<{models: {User: {roleId: string}[]}}>(updated).models.User[0].roleId).toBe(member.id);
  });
});
