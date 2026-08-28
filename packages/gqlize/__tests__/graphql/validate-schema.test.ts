import Sequelize from "sequelize";
import {GraphQLObjectType, GraphQLString, graphql} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import type {Definition} from "../../src/types";

/**
 * Issue #54: `options.root.subscription` is applied before any generated type is
 * reachable, so a subscription field typed off `schema.$sql2gql.types` builds
 * against an empty map and produces a field with no type. graphql accepted that
 * schema, then failed *every* operation against it — including queries with
 * nothing to do with the subscription — because `validateSchema` runs once per
 * execution and returns the same errors regardless of what was asked for.
 *
 * The build-time check turns that into one error naming the field.
 */

const SUBJECT: Definition = {
  name: "Subject",
  define: {name: {type: Sequelize.STRING, allowNull: true}},
  relationships: [],
};

/** A subscription root whose one field has no type — the #54 shape, minimised. */
function brokenSubscription() {
  return new GraphQLObjectType({
    name: "Subscription",
    fields: () => ({
      // `undefined` is what reading a not-yet-built model type off the hatch
      // hands back; graphql stores it and reports it only at validation.
      subjectChanged: {type: undefined as unknown as typeof GraphQLString},
    }),
  });
}

describe("build-time schema validation", () => {
  it("throws on an invalid schema instead of leaving it to the first query", async() => {
    const instance = await createInstance([SUBJECT]);

    await expect(createSchema(instance, {root: {subscription: brokenSubscription()}}))
      .rejects.toThrow(/gqlize: the generated schema is not a valid GraphQL schema/);
  });

  it("names the offending coordinate and keeps graphql's own errors reachable", async() => {
    const instance = await createInstance([SUBJECT]);
    let error: (Error & {errors?: readonly {message: string}[]}) | undefined;
    try {
      await createSchema(instance, {root: {subscription: brokenSubscription()}});
    } catch (err) {
      error = err as Error & {errors?: readonly {message: string}[]};
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("Subscription.subjectChanged");
    expect(error!.message).toContain("`options.root`");
    expect(error!.errors?.length).toBeGreaterThan(0);
  });

  it("`validate: false` restores the old behaviour — the build passes, the query fails", async() => {
    const instance = await createInstance([SUBJECT]);
    const schema = await createSchema(instance, {
      root: {subscription: brokenSubscription()},
      validate: false,
    });

    // This is what #54 looked like: an unrelated query, killed by a bad
    // subscription field, at request time.
    const result = await graphql({schema, source: "{ models { Subject { total } } }"});
    expect(result.errors?.[0]?.message).toContain("Subscription.subjectChanged");
  });

  it("leaves a valid schema alone", async() => {
    const instance = await createInstance([SUBJECT]);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: "{ models { Subject { total } } }"});
    expect(result.errors).toBeUndefined();
  });
});
