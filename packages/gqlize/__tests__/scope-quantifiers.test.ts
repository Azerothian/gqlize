// Relationship quantifiers in `scope`, seen through the schema.
//
// The ormize suite (`ormize/__tests__/scope-quantifiers.test.ts`) proves the
// compiler on root reads. This file covers the other places a scope's `where`
// reaches the adapter, where the outer table goes by a different alias: an
// eager-loaded nested connection or single-valued relationship (aliased by the
// association name), a `required` include, `total`, `node(id:)`, and the write
// paths. It also pins the RFC §4.5 ordering: a create whose scope is satisfied
// only by a row its own nested write creates.

import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { fromGlobalId } from "graphql-relay";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { describe, it, expect, beforeAll } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerSuiteTeardown, registerTeardown } from "./helper/dialect";

const DocDef: Definition = {
  name: "Doc",
  options: { timestamps: false },
  define: {
    name: { type: Sequelize.STRING },
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
    body: { type: Sequelize.STRING, allowNull: true },
    ownerId: { type: Sequelize.STRING, allowNull: true, writable: true },
    docId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [
    { type: "belongsTo", model: "Doc", name: "doc", options: { foreignKey: "docId" } },
  ],
};

type Result = { errors?: readonly { message: string }[]; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- each test reads its own corner of the response

const userOf = (context: unknown) => (context as { user?: string } | undefined)?.user;

async function build(scope?: ScopePredicate, options: { suite?: boolean } = {}) {
  const db = new Database(scope ? { permission: { scope } } : undefined);
  const { adapter, name, teardown } = await createAdapterForDialect();
  (options.suite ? registerSuiteTeardown : registerTeardown)(teardown);
  db.registerAdapter(adapter, name);
  await db.addDefinition(DocDef);
  await db.addDefinition(NoteDef);
  await db.initialise();
  await db.sync();
  return { db, schema: await createSchema(db) };
}

const ask = (schema: GraphQLSchema, source: string, user?: string, variableValues?: { [k: string]: unknown }) =>
  graphql({ schema, source, contextValue: user ? { user } : {}, variableValues }) as unknown as Promise<Result>;

// A note is visible when its doc belongs to the caller; a doc is visible when
// the caller owns at least one of its notes. Both rules live on the *other*
// side of a relationship, so every read of either model goes through a
// quantifier, including when it is the included side of a join.
const crossScope: ScopePredicate = (defName, operation, _options, context) => {
  const user = userOf(context);
  if (operation === "create") {
    return undefined;
  }
  if (defName === "Note") {
    return { where: { doc: { is: { ownerId: { eq: user } } } } };
  }
  return { where: { notes: { some: { ownerId: { eq: user } } } } };
};

describe("gqlize - scope quantifiers at every read path", () => {
  let schema: GraphQLSchema;
  let ourDoc: string;
  let theirDoc: string;
  let ourNote: string;

  beforeAll(async() => {
    const built = await build(crossScope, { suite: true });
    schema = built.schema;
    const seed = async(user: string, doc: string, note: string) => {
      const result = await ask(schema, `mutation {
        models { Doc(create: {name: "${doc}", ownerId: "${user}", notes: {create: {body: "${note}", ownerId: "${user}"}}}) { id notes { edges { node { id } } } } }
      }`, user);
      expect(result.errors).toBeUndefined();
      return result.data.models.Doc[0];
    };
    const ours = await seed("u1", "ours", "our note");
    const theirs = await seed("u2", "theirs", "their note");
    ourDoc = ours.id;
    theirDoc = theirs.id;
    ourNote = ours.notes.edges[0].node.id;
  });

  it("root connection and total", async() => {
    const result = await ask(schema, "query { models { Note { total edges { node { body } } } } }", "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.edges.map((e: { node: { body: string } }) => e.node.body)).toEqual(["our note"]);
    expect(result.data.models.Note.total).toEqual(1);
  });

  it("eager-loaded nested connection, where the scoped model is the included side", async() => {
    const result = await ask(schema,
      "query { models { Doc { edges { node { name notes { total edges { node { body } } } } } } } }", "u1");
    expect(result.errors).toBeUndefined();
    const docs = result.data.models.Doc.edges.map((e: { node: unknown }) => e.node);
    expect(docs).toEqual([{ name: "ours", notes: { total: 1, edges: [{ node: { body: "our note" } }] } }]);
  });

  it("eager-loaded single-valued relationship", async() => {
    const result = await ask(schema, "query { models { Note { edges { node { body doc { name } } } } } }", "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.edges.map((e: { node: unknown }) => e.node))
      .toEqual([{ body: "our note", doc: { name: "ours" } }]);
  });

  it("required include through two scoped levels", async() => {
    const result = await ask(schema, `query { models { Note(include: [{doc: {required: true, include: [{notes: {required: true}}]}}]) {
      total edges { node { body } }
    } } }`, "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.edges.map((e: { node: { body: string } }) => e.node.body)).toEqual(["our note"]);
    expect(result.data.models.Note.total).toEqual(1);
  });

  it("node(id:)", async() => {
    const source = "query n($id: ID!) { node(id: $id) { id ... on Doc { name } } }";
    expect((await ask(schema, source, "u1", { id: theirDoc })).data.node).toBeNull();
    expect((await ask(schema, source, "u1", { id: ourDoc })).data.node.name).toEqual("ours");
  });

  it("update and delete only reach rows inside the quantifier scope", async() => {
    const theirId = fromGlobalId(theirDoc).id;
    const stolen = await ask(schema, `mutation {
      models { Doc(update: {where: {id: {eq: "${theirId}"}}, input: {name: "stolen"}}) { id } }
    }`, "u1");
    expect(stolen.data.models.Doc).toEqual([]);
    await ask(schema, `mutation { models { Doc(delete: {where: {id: {eq: "${theirId}"}}}) { id } } }`, "u1");
    const after = await ask(schema, "query { models { Doc { edges { node { name } } } } }", "u2");
    expect(after.data.models.Doc.edges.map((e: { node: { name: string } }) => e.node.name)).toEqual(["theirs"]);

    const ourNoteId = fromGlobalId(ourNote).id;
    const edited = await ask(schema, `mutation {
      models { Note(update: {where: {id: {eq: "${ourNoteId}"}}, input: {body: "edited"}}) { body } }
    }`, "u1");
    expect(edited.errors).toBeUndefined();
    expect(edited.data.models.Note).toEqual([{ body: "edited" }]);
  });
});

describe("gqlize - scope quantifiers on create (RFC §4.5)", () => {
  // A doc is in scope when the caller owns one of its notes. A create can only
  // satisfy that through its own nested note, so the post-write re-check has
  // to run after the nested write, and a failure has to undo both rows.
  const docScope: ScopePredicate = (defName, _operation, _options, context) =>
    defName === "Doc" ? { where: { notes: { some: { ownerId: { eq: userOf(context) } } } } } : undefined;

  it("accepts a create whose nested write satisfies the scope", async() => {
    const { schema } = await build(docScope);
    const result = await ask(schema, `mutation {
      models { Doc(create: {name: "mine", notes: {create: {body: "n", ownerId: "u1"}}}) { name } }
    }`, "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Doc).toEqual([{ name: "mine" }]);
  });

  it("refuses one whose nested write does not, and rolls back both rows", async() => {
    const { db, schema } = await build(docScope);
    const result = await ask(schema, `mutation {
      models { Doc(create: {name: "escape", notes: {create: {body: "n", ownerId: "u2"}}}) { name } }
    }`, "u1");
    expect(result.errors).toBeDefined();
    // Counted below the scope, straight off the models.
    expect(await db.models.Doc.count()).toEqual(0);
    expect(await db.models.Note.count()).toEqual(0);
  });
});

describe("gqlize - scope quantifiers: nested writes under the cross scope", () => {
  // The note's rule covers every operation, create included, so a note may
  // only ever exist under a doc the caller owns. That rule is only decidable
  // once the link exists, which is the RFC §4.5 case on the child side.
  const childScope: ScopePredicate = (defName, operation, _options, context) => {
    const user = userOf(context);
    if (defName === "Note") {
      return { where: { doc: { is: { ownerId: { eq: user } } } } };
    }
    return operation === "create" ? undefined : { where: { notes: { some: { ownerId: { eq: user } } } } };
  };

  it("links a nested child whose scope depends on the link it is getting", async() => {
    const { db, schema } = await build(childScope);
    const result = await ask(schema, `mutation {
      models { Doc(create: {name: "mine", ownerId: "u1", notes: {create: {body: "n", ownerId: "u1"}}}) { name } }
    }`, "u1");
    expect(result.errors).toBeUndefined();
    const [note] = await db.models.Note.findAll();
    expect(note.docId).not.toBeNull();
  });

  it("refuses a nested child that the link leaves outside its own scope, and rolls back", async() => {
    // u1 creates a doc owned by u2. The linking call may skip the hooks, but
    // the re-check after it must not, or this note would be written where its
    // own create rule forbids.
    const { db, schema } = await build(childScope);
    const result = await ask(schema, `mutation {
      models { Doc(create: {name: "planted", ownerId: "u2", notes: {create: {body: "n", ownerId: "u1"}}}) { name } }
    }`, "u1");
    expect(result.errors).toBeDefined();
    expect(await db.models.Doc.count()).toEqual(0);
    expect(await db.models.Note.count()).toEqual(0);
  });

  it("select reaches only related rows inside the target's quantifier scope", async() => {
    const { db, schema } = await build(crossScope);
    const mine = await db.models.Doc.create({ name: "mine", ownerId: "u1" });
    await db.models.Note.create({ body: "mine", ownerId: "u1", docId: mine.id });
    const theirs = await db.models.Doc.create({ name: "theirs", ownerId: "u2" });
    await db.models.Note.create({ body: "theirs", ownerId: "u2", docId: theirs.id });
    // Through select on Note, walk to its doc and rename it. u1 can only reach
    // its own note, so only its own doc may change.
    const result = await ask(schema, `mutation {
      models { Note(select: [{ where: {}, input: { doc: { select: { where: {}, input: { notes: { create: [{ body: "added", ownerId: "u1" }] } } } } } }]) { body } }
    }`, "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.map((n: { body: string }) => n.body)).toEqual(["mine"]);
    const theirNotes = await db.models.Note.count({ where: { docId: theirs.id } });
    expect(theirNotes).toEqual(1);
    const myNotes = await db.models.Note.count({ where: { docId: mine.id } });
    expect(myNotes).toEqual(2);
  });
});

describe("gqlize - every and NULL", () => {
  it("a related row with a NULL in the compared column fails `every`", async() => {
    // `some: {body: {eq: "ok"}}` does not count a NULL body as a match, so
    // `every` must not count it as one either; otherwise a NULL widens scope.
    const scope: ScopePredicate = (defName) =>
      defName === "Doc" ? { where: { notes: { every: { body: { eq: "ok" } } } } } : undefined;
    const { db, schema } = await build(scope);
    const clean = await db.models.Doc.create({ name: "clean" });
    const dirty = await db.models.Doc.create({ name: "dirty" });
    await db.models.Note.bulkCreate([
      { body: "ok", docId: clean.id },
      { body: "ok", docId: dirty.id },
      { body: null, docId: dirty.id },
    ]);
    const result = await ask(schema, "query { models { Doc { edges { node { name } } } } }", "u1");
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Doc.edges.map((e: { node: { name: string } }) => e.node.name)).toEqual(["clean"]);
  });
});
