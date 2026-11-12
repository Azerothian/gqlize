/**
 * #68: an adapter with `includeIsList = false` types the `include` argument as
 * one input object rather than a list. The engine normalises either shape, so
 * a query that supplies it reaches the adapter instead of throwing
 * "include is not iterable". Offline: the throw happened before any adapter
 * call, so a fake client is enough.
 */
import { it, expect } from "@jest/globals";
import { graphql, printSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import ValkeyAdapter from "../src";

/** Satisfies `looksLikeClient`; a query that reaches it fails on the missing command, not on the plan. */
const fakeClient = { get: () => {}, set: () => {}, multi: () => {} } as never;

it("an explicit single-object include is read, not thrown on (#68)", async () => {
  const orm = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix: "repro" }, fakeClient), "db");
  await orm.addDefinition({
    name: "Author",
    define: { id: { type: DataTypes.Int, primaryKey: true }, name: { type: DataTypes.String } },
    options: {},
    relationships: [{ type: "hasMany", model: "Post", name: "posts", options: { foreignKey: "authorId" } }],
  });
  await orm.addDefinition({
    name: "Post",
    define: { id: { type: DataTypes.Int, primaryKey: true }, title: { type: DataTypes.String }, authorId: { type: DataTypes.Int, index: true } },
    options: {},
    relationships: [{ type: "belongsTo", model: "Author", name: "author", options: { foreignKey: "authorId" } }],
  });
  await orm.initialise({ ddl: false });
  const schema = await createSchema(orm);
  expect(printSchema(schema)).toContain("input GQLTAuthorInclude ");
  const result = await graphql({ schema, source: `{ models { Author(include: {posts: {}}) { total } } }` });
  for (const error of result.errors || []) {
    expect(error.message).not.toMatch(/not iterable/);
  }
});
