/**
 * The explicit `include` argument: every level of it reaches the engine as a
 * complete `IncludeMap[]` (target and association type filled in from the live
 * associations), so the target's row scope applies at every depth — at the root
 * and on a nested relationship connection resolved per parent — and a
 * client-supplied plan merges with the auto-include one instead of being lost.
 */
import {graphql, type GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {Ormize as Database} from "@azerothian/ormize";
import type {ScopePredicate} from "@azerothian/utilize";
import {createSchema} from "../src";
import {registerDialectAdapter} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";
import type {Definition} from "../src/types";

const defs: Definition[] = [
  {name: "Shelf", define: {name: {type: Sequelize.STRING}},
    relationships: [{type: "hasMany", model: "Book", name: "books", options: {foreignKey: "shelfId"}}]},
  {name: "Book", define: {title: {type: Sequelize.STRING}},
    relationships: [
      {type: "belongsTo", model: "Shelf", name: "shelf", options: {foreignKey: "shelfId"}},
      {type: "hasMany", model: "Note", name: "notes", options: {foreignKey: "bookId"}},
    ]},
  {name: "Note", define: {body: {type: Sequelize.STRING}, visible: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true}},
    relationships: [{type: "belongsTo", model: "Book", name: "book", options: {foreignKey: "bookId"}}]},
];

/** Notes marked invisible are out of the read scope. */
const visibleNotes: ScopePredicate = (defName, operation) =>
  defName === "Note" && operation === "read" ? {where: {visible: {eq: true}}} : undefined;

/**
 * open: book "a" with a visible note. hidden: book "b" whose only note is
 * invisible. bare: book "c" with no notes.
 */
async function build() {
  const db = new Database({permission: {scope: visibleNotes}});
  await registerDialectAdapter(db);
  for (const d of defs) {
    await db.addDefinition(d);
  }
  await db.initialise();
  await db.sync();
  const {Shelf, Book, Note} = db.models;
  const add = async(shelf: string, title: string, visible?: boolean) => {
    const s = await Shelf.create({name: shelf}) as unknown as {get: (k: string) => unknown};
    const b = await Book.create({title, shelfId: s.get("id")}) as unknown as {get: (k: string) => unknown};
    if (visible !== undefined) {
      await Note.create({body: "n", visible, bookId: b.get("id")});
    }
  };
  await add("open", "a", true);
  await add("hidden", "b", false);
  await add("bare", "c");
  return createSchema(db, {});
}

async function run(schema: GraphQLSchema, source: string) {
  const res = await graphql({schema, source});
  if (res.errors?.length) {
    throw res.errors[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walked by field name
  return res.data as any;
}

const shelfNames = (data: {models: {Shelf: {edges: {node: {name: string}}[]}}}) =>
  data.models.Shelf.edges.map((e) => e.node.name);

describe("explicit include plans", () => {
  it("a nested explicit include is scoped at its own depth", async () => {
    const schema = await build();
    // Shelves holding a book that has a note the caller can see.
    const data = await run(schema, `{ models {
      Shelf(orderBy: nameASC, include: [{books: {required: true, include: [{notes: {required: true}}]}}]) { edges { node { name } } }
    } }`);
    expect(shelfNames(data)).toEqual(["open"]);
  });

  it("an explicit include on a nested connection is scoped too", async () => {
    const schema = await build();
    const data = await run(schema, `{ models { Shelf(orderBy: nameASC) { edges { node { name
      books(include: [{notes: {required: true}}]) { edges { node { title } } }
    } } } } }`);
    const titles = data.models.Shelf.edges.map((e: {node: {books: {edges: {node: {title: string}}[]}}}) =>
      e.node.books.edges.map((b) => b.node.title));
    expect(titles).toEqual([[], [], ["a"]]);
  });

  it("an explicit include merges with the auto-include plan, every element of it", async () => {
    const schema = await build();
    // Two elements: the second used to be dropped by an `explicit[0]` merge.
    const data = await run(schema, `{ models {
      Shelf(orderBy: nameASC, include: [{books: {}}, {books: {required: true, include: [{notes: {required: true}}]}}]) {
        edges { node { name books { edges { node { title } } } } }
      }
    } }`);
    expect(shelfNames(data)).toEqual(["open"]);
  });
});
