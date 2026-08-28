import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { fromGlobalId } from "graphql-relay";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { describe, it, expect, beforeAll } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

// The whole feature, seen from the only place a caller actually stands.
//
// Each of these has an ormize-level twin already; what they add is the funnel.
// A root list, a nested connection, a `total`, `node(id:)` and every mutation
// verb are five different gqlize resolvers, and the claim behind §4 is that all
// five reach the engine through one chokepoint. If one ever grows its own path
// to the adapter, this file is where it shows.

const DocDef: Definition = {
  name: "Doc",
  options: { timestamps: false },
  define: {
    name: { type: Sequelize.STRING },
    // Filled in by the scope rather than the client, so it must be nullable at
    // the schema level; `writable` so the forgery test has something to forge.
    ownerId: { type: Sequelize.STRING, allowNull: true, writable: true },
  },
  relationships: [
    { type: "hasMany", model: "Note", name: "notes", options: { foreignKey: "docId" } },
  ],
};

const NoteDef: Definition = {
  name: "Note",
  options: { timestamps: false },
  define: {
    body: { type: Sequelize.STRING },
    ownerId: { type: Sequelize.STRING, allowNull: true, writable: true },
    docId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [
    { type: "belongsTo", model: "Doc", name: "doc", options: { foreignKey: "docId" } },
  ],
};

interface Connection<T> {
  total: number;
  edges: {node: T}[];
}
interface NoteNode {
  body: string;
}
interface DocNode {
  id: string;
  name: string;
  ownerId: string | null;
  notes: Connection<NoteNode>;
}

/**
 * Only the corners of a response these tests actually read.
 *
 * `Doc` is an intersection because it genuinely is two shapes: a connection
 * under `query`, a row list under `mutation`. That is gqlize's schema, not a
 * looseness in the test.
 */
interface Response {
  errors?: readonly unknown[];
  data: {
    node: DocNode | null;
    models: {Doc: Connection<DocNode> & (DocNode | null)[]};
  };
}

/** The principal, read off the graphql context every resolver already threads. */
const owned: ScopePredicate = (_defName, _operation, _options, context) => {
  const id = (context as { user?: string } | undefined)?.user;
  return { where: { ownerId: { eq: id } }, set: { ownerId: id } };
};

async function build(scope?: ScopePredicate) {
  const db = new Database(scope ? { permission: { scope } } : undefined);
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  await db.addDefinition(DocDef);
  await db.addDefinition(NoteDef);
  await db.initialise();
  await db.sync();
  return { db, schema: await createSchema(db) };
}

const ask = (schema: GraphQLSchema, source: string, user?: string, variableValues?: {[k: string]: unknown}) =>
  graphql({ schema, source, contextValue: user ? { user } : {}, variableValues }) as unknown as Promise<Response>;

describe("gqlize - row-level scope through the schema", () => {
  let schema: GraphQLSchema;
  let ourDoc: string;
  let theirDoc: string;

  const run = (source: string, user?: string) => ask(schema, source, user);

  const seed = async(user: string, doc: string, note: string) => {
    const result = await run(`mutation {
      models { Doc(create: {name: "${doc}", notes: {create: {body: "${note}"}}}) { id } }
    }`, user);
    expect(result.errors).toBeUndefined();
    return result.data.models.Doc[0]!.id;
  };

  beforeAll(async() => {
    ({ schema } = await build(owned));
    ourDoc = await seed("u1", "ours", "our note");
    theirDoc = await seed("u2", "theirs", "their note");
  });

  it("narrows a root connection and its total together", async() => {
    const result = await run("query { models { Doc { total edges { node { name } } } } }", "u1");
    expect(result.data.models.Doc.edges.map((e) => e.node.name)).toEqual(["ours"]);
    expect(result.data.models.Doc.total).toEqual(1);
  });

  it("narrows a nested connection and its total (F4)", async() => {
    // Seeded one note each, both attached to their own doc; a note is scoped by
    // its *own* owner, so u1 asking u1's doc for notes sees exactly its own.
    const result = await run(
      "query { models { Doc { edges { node { name notes { total edges { node { body } } } } } } } }", "u1");
    const [doc] = result.data.models.Doc.edges;
    expect(doc.node.notes.edges.map((e) => e.node.body)).toEqual(["our note"]);
    expect(doc.node.notes.total).toEqual(1);
  });

  it("returns null from node(id:) for a row the caller may not see", async() => {
    const source = `query n($id: ID!) { node(id: $id) { id ... on Doc { name } } }`;
    const hidden = await ask(schema, source, "u1", { id: theirDoc });
    expect(hidden.data.node).toBeNull();
    // The same principal, a different id: without this the null above would be
    // satisfied just as well by a `node` fetcher that had stopped resolving.
    const mine = await ask(schema, source, "u1", { id: ourDoc });
    expect(mine.data.node!.name).toEqual("ours");
    const own = await ask(schema, source, "u2", { id: theirDoc });
    expect(own.data.node!.name).toEqual("theirs");
  });

  it("returns nothing from an update naming a row the caller may not see", async() => {
    const id = fromGlobalId(theirDoc).id;
    const result = await run(`mutation {
      models { Doc(update: {where: {id: {eq: "${id}"}}, input: {name: "stolen"}}) { id name } }
    }`, "u1");
    // An empty list is gqlize's ordinary shape for an update that matched
    // nothing — a bogus id on an unscoped schema returns the same. The
    // load-bearing assertion is the next one: the row itself was not touched.
    expect(result.data.models.Doc).toEqual([]);
    const after = await run("query { models { Doc { edges { node { name } } } } }", "u2");
    expect(after.data.models.Doc.edges.map((e) => e.node.name)).toEqual(["theirs"]);
  });

  it("deletes nothing when the delete names a row the caller may not see", async() => {
    const id = fromGlobalId(theirDoc).id;
    await run(`mutation {
      models { Doc(delete: {where: {id: {eq: "${id}"}}}) { id } }
    }`, "u1");
    const after = await run("query { models { Doc { total } } }", "u2");
    expect(after.data.models.Doc.total).toEqual(1);
  });

  it("forces the owning field on create, over a value the client sent", async() => {
    const result = await run(`mutation {
      models { Doc(create: {name: "forged", ownerId: "u2"}) { id ownerId } }
    }`, "u1");
    // A denial, not a silent overwrite: "we wrote the safe value anyway" hides a
    // request that tried, and the request that tried is the interesting one.
    expect(result.errors).toBeDefined();
    const theirs = await run("query { models { Doc { edges { node { name } } } } }", "u2");
    expect(theirs.data.models.Doc.edges.map((e) => e.node.name)).toEqual(["theirs"]);
  });

  it("stamps the owner on a create that leaves the field alone", async() => {
    const result = await run(`mutation {
      models { Doc(create: {name: "fresh"}) { ownerId } }
    }`, "u1");
    expect(result.data.models.Doc[0]!.ownerId).toEqual("u1");
  });

  it("shows every row to a schema built without a scope", async() => {
    // The control. Everything above is the scope working; this is the same
    // schema shape proving the tests are not simply reading an empty database.
    const bare = await build();
    await ask(bare.schema, `mutation { models { Doc(create: {name: "a"}) { id } } }`);
    await ask(bare.schema, `mutation { models { Doc(create: {name: "b"}) { id } } }`);
    const result = await ask(bare.schema, "query { models { Doc { total } } }");
    expect(result.data.models.Doc.total).toEqual(2);
  });

  it("does not let a scoped child become a filter on its parent", async() => {
    // Decision 6. `u1` owns a doc whose notes it cannot see once the note scope
    // pins a different owner — the doc must still come back, with no notes.
    const only = await build((defName, operation, _opts, context) => {
      const id = (context as { user?: string })?.user;
      if (defName === "Note") {
        // Unreadable, but still creatable. Scoping the child's *write* as well
        // would make the seeding create fail its post-write re-check (F6), and
        // the test would then pass for the wrong reason — no parent row at all.
        return operation === "read" ? { where: { ownerId: { eq: "nobody" } } } : undefined;
      }
      return { where: { ownerId: { eq: id } }, set: { ownerId: id } };
    });
    await ask(only.schema, `mutation {
      models { Doc(create: {name: "parent", notes: {create: {body: "child"}}}) { id } }
    }`, "u1");
    const result = await ask(
      only.schema, "query { models { Doc { edges { node { name notes { total } } } } } }", "u1");
    expect(result.data.models.Doc.edges).toHaveLength(1);
    expect(result.data.models.Doc.edges[0].node.notes.total).toEqual(0);
  });
});
