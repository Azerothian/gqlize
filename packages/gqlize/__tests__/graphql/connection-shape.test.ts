import {
  GraphQLNonNull,
  GraphQLList,
  GraphQLObjectType,
  isNonNullType,
  printSchema,
  type GraphQLSchema,
} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";

/**
 * The Relay Connections spec requires `pageInfo: PageInfo!` with both page flags
 * non-null. gqlize goes one step further and marks `edges` and `cursor` non-null
 * too, because `resolvers/connection.ts` always returns an array and mints every
 * cursor itself — a client that null-checks them is checking for a value the
 * server has no way to produce.
 *
 * `total` and `edges.node` stay nullable on purpose, and are asserted here so a
 * later "tighten everything" pass has to argue with a test rather than a comment.
 */

function connectionType(schema: GraphQLSchema) {
  const models = schema.getType("QueryModels") as GraphQLObjectType;
  const field = models.getFields().Task;
  expect(isNonNullType(field.type)).toBe(false);
  return field.type as GraphQLObjectType;
}

describe("relay connection nullability", () => {
  it("marks pageInfo, edges and cursor non-null and leaves total and node nullable", async() => {
    const schema = await createSchema(await createInstance());
    const fields = connectionType(schema).getFields();

    expect(String(fields.pageInfo.type)).toEqual("PageInfo!");
    expect(String(fields.edges.type)).toEqual("[TaskEdge!]!");
    // a separate COUNT the include builder may skip — not the resolver's promise
    expect(String(fields.total.type)).toEqual("Int");

    const edge = (fields.edges.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>)
      .ofType.ofType.ofType;
    expect(String(edge.getFields().cursor.type)).toEqual("String!");
    // the row can go away between the page query and the per-edge node resolve
    expect(String(edge.getFields().node.type)).toEqual("Task");
  });

  it("marks both PageInfo page flags non-null and leaves the cursors nullable", async() => {
    const schema = await createSchema(await createInstance());
    const pageInfo = (schema.getType("PageInfo") as GraphQLObjectType).getFields();

    expect(String(pageInfo.hasNextPage.type)).toEqual("Boolean!");
    expect(String(pageInfo.hasPreviousPage.type)).toEqual("Boolean!");
    // an empty page has no first or last edge to name
    expect(String(pageInfo.startCursor.type)).toEqual("String");
    expect(String(pageInfo.endCursor.type)).toEqual("String");
  });

  it("survives the artifact round-trip", async() => {
    const instance = await createInstance();
    const live = await createSchema(instance);
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
    const rebuilt = await materializeSchema(artifact, instance);

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    expect(printSchema(rebuilt)).toContain("pageInfo: PageInfo!");
    expect(printSchema(rebuilt)).toContain("hasNextPage: Boolean!");
    expect(printSchema(rebuilt)).toContain("edges: [TaskEdge!]!");
  });
});
