import Sequelize from "sequelize";
import { toGlobalId } from "graphql-relay";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "../src";
import { describe, expect, it, beforeAll } from "@jest/globals";

// Regression cover for the global-id decode guard.
//
// `replaceIdInWhere` decodes Relay global ids out of a where tree. It used to
// decode any string matching the base64 *charset*, which is not the same test as
// "is a global id": "ABCD1234" is valid base64, so a legitimate string primary
// key was base64-decoded into binary garbage and the filter silently matched no
// rows. These assert both halves — real global ids still decode, plain values are
// left exactly as the caller wrote them.

// Length % 4 === 0 and inside the base64 alphabet, so every one of these trips
// the charset pre-filter and reaches the decoder.
const PLAIN_IDS = ["ABCD1234", "deadbeef", "abcdefgh", "AAAAAAAA"];

let adapter: SequelizeAdapter;
let db: Ormize;

beforeAll(async () => {
  adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
  db = new Ormize().registerAdapter(adapter);
  db.addDefinition({
    name: "Thing",
    define: {
      // A string primary key is the case the old guard corrupted; an
      // auto-increment integer key never reaches the decoder.
      id: { type: Sequelize.STRING, primaryKey: true },
      name: { type: Sequelize.STRING, allowNull: true },
    },
  });
  await db.initialise();
  await db.sync();
});

describe("replaceIdInWhere - global id decoding", () => {
  it.each(PLAIN_IDS)("leaves the base64-shaped plain id %s untouched", (id) => {
    expect(adapter.replaceIdInWhere({ id }, "Thing")).toEqual({ id });
  });

  it("still decodes a genuine global id", () => {
    expect(adapter.replaceIdInWhere({ id: toGlobalId("Thing", "ABCD1234") }, "Thing"))
      .toEqual({ id: "ABCD1234" });
  });

  it("decodes through operator wrappers and arrays, but only real global ids", () => {
    expect(
      adapter.replaceIdInWhere(
        { id: { in: [toGlobalId("Thing", "7"), "ABCD1234"] } },
        "Thing"
      )
    ).toEqual({ id: { in: ["7", "ABCD1234"] } });
  });

  it("does not touch values outside a global-key field", () => {
    const encoded = toGlobalId("Thing", "7");
    expect(adapter.replaceIdInWhere({ name: encoded }, "Thing")).toEqual({ name: encoded });
  });

  it("passes a filter on a base64-shaped id through to a real query", async () => {
    // The end-to-end shape of the bug: the row exists, the filter is correct, and
    // the old code still returned nothing.
    await db.models.Thing.create({ id: "ABCD1234", name: "alpha" });
    const where = adapter.replaceIdInWhere({ id: "ABCD1234" }, "Thing") as { id: string };
    const rows = await adapter.findAll("Thing", { where });
    expect(rows).toHaveLength(1);
    expect(rows[0].get("name")).toEqual("alpha");
  });
});
