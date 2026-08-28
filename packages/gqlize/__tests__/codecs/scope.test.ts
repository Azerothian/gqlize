import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { describe, it, expect, beforeAll, jest } from "@jest/globals";

import { createSchema, prefixIdCodec, rawIdCodec } from "../../src";
import type { IdCodec } from "../../src/types";
import { createAdapterForDialect, registerTeardown } from "../helper/dialect";

// The seam between two features that landed independently: pluggable id codecs
// (#42) and row-level `permission.scope` (#40).
//
// Both rewrite a mutation's `where`, and they must do it in one order. A scope
// is resolved on the server and already holds **raw** ids; a caller's filter
// holds **opaque** ones. `translateFilter` therefore runs first and the scope is
// merged onto its output — never the reverse, which would feed a server-side raw
// key to a codec that did not mint it.
//
// Reads cannot get this wrong by construction: the decode happens in the gqlize
// binding (`replaceIdInArgs`) before ormize is entered at all, and the read
// scope is merged inside `resolveFindAll`. Writes do both inside `processUpdate`
// / `processDelete` / `processSelect`, where the order is one line's worth of
// choice — so that is what these tests stand on.

const DocDef: Definition = {
  name: "Doc",
  options: { timestamps: false },
  define: {
    name: { type: Sequelize.STRING },
    // Nullable because validation runs before a scope's `set` applies.
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
    docId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [
    { type: "belongsTo", model: "Doc", name: "doc", options: { foreignKey: "docId" } },
  ],
};

/**
 * A codec whose format overlaps with raw keys, which is what makes the ordering
 * observable at all.
 *
 * None of the shipped codecs can show it: `relayIdCodec` and `prefixIdCodec`
 * both return `null` for a bare `"1"` (it is not base64-shaped, and it carries
 * no prefix), and `rawIdCodec` is the identity — so on all three, running a
 * scope's raw key through `decode` happens to leave it alone. That is #42's
 * null-return design paying off, not a reason to stop caring about the order: a
 * numeric offset is a real way to stop ids leaking row counts, and under it a
 * raw `1` decodes to `-999`.
 *
 * `carriesType: false` for the same reason `rawIdCodec` declares it — an integer
 * cannot say which model it names.
 */
const OFFSET = 1000;
function offsetIdCodec(): IdCodec {
  return {
    carriesType: false,
    encode: ({id}) => `${Number(id) + OFFSET}`,
    decode: ({value}) => (/^-?\d+$/.test(value) ? {type: "", id: `${Number(value) - OFFSET}`} : null),
  };
}

interface NoteRow {
  id: string;
  body: string;
  docId: string;
}

interface Response {
  errors?: readonly {message: string}[];
  data: {
    models: {
      Doc: {id: string; name: string}[] & {total: number};
      Note: (NoteRow | null)[] & {total: number; edges: {node: NoteRow}[]};
    };
  };
}

async function build(options: {id: IdCodec; scope?: ScopePredicate}) {
  const db = new Database(options.scope ? {permission: {scope: options.scope}} : undefined);
  const {adapter, name, teardown} = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  await db.addDefinition(DocDef);
  await db.addDefinition(NoteDef);
  await db.initialise();
  await db.sync();
  return createSchema(db, {id: options.id});
}

const ask = (schema: GraphQLSchema, source: string) =>
  graphql({schema, source}) as unknown as Promise<Response>;

// ---------------------------------------------------------------------------
// 1. A scope's raw ids are not run through the codec.
// ---------------------------------------------------------------------------
describe("codecs + scope - a scope's raw ids never reach the codec", () => {
  let schema: GraphQLSchema;
  let noteId: string;
  let otherNoteId: string;
  const id = offsetIdCodec();

  // "You may only touch notes on the doc you are in" — the doc's key is resolved
  // on the server, so it is raw, and it names a *global* key on `Note`. Both
  // halves matter: a scope on a plain column would pass through `translateFilter`
  // untouched whatever the order, and would pin nothing.
  //
  // Narrowed to the two write verbs on purpose, and not only to keep the seed
  // buildable (F6's post-write re-check refuses a `create` landing outside the
  // filter, and a scoped `read` would hide the out-of-scope note from the
  // queries below — leaving the suite to run against a database with nothing
  // outside the scope in it, passing for the opposite of the intended reason).
  // The ordering is *only* decidable on a write: on a read the decode happens in
  // the gqlize binding, before ormize is entered, so no line in ormize could put
  // the two in the wrong order even if it wanted to.
  const pinnedToFirstDoc: ScopePredicate = (defName, operation) =>
    (defName === "Note" && (operation === "update" || operation === "delete")
      ? {where: {docId: {eq: "1"}}}
      : undefined);

  const newDoc = async(name: string) => {
    const created = await ask(schema, `mutation {
      models { Doc(create: {name: "${name}"}) { id } }
    }`);
    expect(created.errors).toBeUndefined();
    return created.data.models.Doc[0].id;
  };

  // The foreign key is set on the create rather than through `notes: {create: …}`.
  // Nesting attaches the child by *updating* its FK afterwards, and the scope
  // under test covers `update` — so the attach would be filtered on the very
  // column it is trying to fill, and both notes would end up unparented. That is
  // #40 behaving correctly on a fixture asking the wrong question; naming
  // `docId` up front asks the right one, and puts an opaque id through a
  // mutation input on the way.
  const newNote = async(body: string, docId: string) => {
    const created = await ask(schema, `mutation {
      models { Note(create: {body: "${body}", docId: "${docId}"}) { id docId } }
    }`);
    expect(created.errors).toBeUndefined();
    expect(created.data.models.Note[0]!.docId).toEqual(docId);
    return created.data.models.Note[0]!.id;
  };

  beforeAll(async() => {
    schema = await build({id, scope: pinnedToFirstDoc});
    // Two docs, so "the scope filtered correctly" is not satisfied by there being
    // only one row in the database.
    const first = await newDoc("first");
    const second = await newDoc("second");
    noteId = await newNote("in scope", first);
    otherNoteId = await newNote("out of scope", second);
  });

  it("mints the offset ids these tests are built on", async() => {
    // The control. If the codec were not actually in play, every assertion below
    // would pass against the default format for the wrong reason.
    expect(noteId).toEqual(`${1 + OFFSET}`);
    const all = await ask(schema, `query { models { Note { edges { node { docId } } } } }`);
    expect(all.data.models.Note.edges.map((e) => e.node.docId)).toContain(`${1 + OFFSET}`);
  });

  it("updates a row the scope allows, naming it by its opaque id", async() => {
    // Reversing the merge order makes this red: the scope's raw `docId: 1` would
    // be decoded to `-999`, the AND would match nothing, and the update would
    // return `[null]` against a row it is entitled to write.
    const result = await ask(schema, `mutation {
      models { Note(update: {where: {id: {eq: "${noteId}"}}, input: {body: "edited"}}) { id body } }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.map((n) => n && n.body)).toEqual(["edited"]);
  });

  it("still refuses a row the scope excludes", async() => {
    // The other half of the same claim: the scope is doing real work, not simply
    // surviving. A scope that decoded to `-999` would pass this vacuously.
    const result = await ask(schema, `mutation {
      models { Note(update: {where: {id: {eq: "${otherNoteId}"}}, input: {body: "stolen"}}) { id } }
    }`);
    expect(result.data.models.Note).toEqual([]);
    const after = await ask(schema, `query { models { Note { edges { node { body } } } } }`);
    expect(after.data.models.Note.edges.map((e) => e.node.body)).toContain("out of scope");
  });

  it("deletes nothing when the delete names a row outside the scope", async() => {
    await ask(schema, `mutation {
      models { Note(delete: {where: {id: {eq: "${otherNoteId}"}}}) { id } }
    }`);
    const after = await ask(schema, `query { models { Note { total } } }`);
    expect(after.data.models.Note.total).toEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 2. A caller's opaque ids still are, with a scope present.
// ---------------------------------------------------------------------------
describe("codecs + scope - a caller's opaque ids are still decoded", () => {
  let schema: GraphQLSchema;
  let docId: string;
  const id = prefixIdCodec({prefixes: {Doc: "DOC", Note: "NOT"}, pad: 6});

  // Scoped, but on a plain column, so the only opaque values in the merged
  // filter are the caller's.
  const everything: ScopePredicate = (defName, operation) =>
    (defName === "Note" && operation !== "create" ? {where: {body: {ne: null}}} : undefined);

  const seed = async(name: string, body: string) => {
    const created = await ask(schema, `mutation {
      models { Doc(create: {name: "${name}", notes: {create: {body: "${body}"}}}) { id } }
    }`);
    expect(created.errors).toBeUndefined();
    return created.data.models.Doc[0].id;
  };

  beforeAll(async() => {
    schema = await build({id, scope: everything});
    docId = await seed("first", "a");
    await seed("second", "b");
  });

  it("decodes a foreign-key global id in a scoped update's where", async() => {
    expect(docId).toEqual("DOC000001");
    const result = await ask(schema, `mutation {
      models { Note(update: {where: {docId: {eq: "${docId}"}}, input: {body: "edited"}}) { id body docId } }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.models.Note.map((n) => n && n.body)).toEqual(["edited"]);
    // Round-tripped back out in the same format, from the same key.
    expect(result.data.models.Note[0]!.docId).toEqual(docId);
  });

  it("refuses an id minted for the wrong model, scope or no scope", async() => {
    // #42's second bug: the type half used to be decoded and discarded, so a
    // `Note` id in a `docId` filter matched whatever `Doc` shared the raw key.
    // The targets map has to survive being threaded through the scoped call
    // site, which is the only thing this asserts that the test above does not.
    const forged = "NOT000001";
    const result = await ask(schema, `mutation {
      models { Note(update: {where: {docId: {eq: "${forged}"}}, input: {body: "stolen"}}) { id } }
    }`);
    expect(result.data.models.Note).toEqual([]);
    const after = await ask(schema, `query { models { Note { edges { node { body } } } } }`);
    expect(after.data.models.Note.edges.map((e) => e.node.body)).toEqual(["edited", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 3. `carriesType: false` + a scope.
// ---------------------------------------------------------------------------
describe("codecs + scope - a codec with no type omits the field a scope would guard", () => {
  it("omits node(id:) and says so, rather than leaving a scope test to pass vacuously", async() => {
    const owned: ScopePredicate = (defName, operation) =>
      (defName === "Doc" && operation !== "create" ? {where: {ownerId: {eq: "u1"}}} : undefined);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let schema: GraphQLSchema;
    try {
      schema = await build({id: rawIdCodec(), scope: owned});
      expect(warn.mock.calls.map((c) => `${c[0]}`).join("\n")).toMatch(/carriesType: false/);
    } finally {
      warn.mockRestore();
    }
    // #40 enforces the scope inside `node(id:)`. Under a codec that cannot name a
    // type there is no such field, so a suite that asserted "node returns null
    // for a row you may not see" here would be asserting nothing at all.
    expect(schema.getQueryType()!.getFields().node).toBeUndefined();
    // The scope is still imposed on everything that does exist: `ownerId` is left
    // null by the create, so nothing the schema can reach comes back.
    const created = await ask(schema, `mutation { models { Doc(create: {name: "a"}) { id } } }`);
    expect(created.errors).toBeUndefined();
    const visible = await ask(schema, `query { models { Doc { total } } }`);
    expect(visible.data.models.Doc.total).toEqual(0);
  });
});
