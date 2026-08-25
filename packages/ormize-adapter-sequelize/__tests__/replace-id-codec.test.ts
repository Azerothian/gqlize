import Sequelize from "sequelize";
import { toGlobalId } from "graphql-relay";
import { Ormize } from "@azerothian/ormize";
import { prefixIdCodec, rawIdCodec } from "@azerothian/gqlize";
import SequelizeAdapter from "../src";
import { describe, expect, it, beforeAll } from "@jest/globals";
import type { AdapterWhere, IncludeMap } from "@azerothian/utilize/types/index";

/**
 * The adapter's `replaceIdIn*` hooks take an `IdTranslation` — the codec plus the
 * type each global key points at. See #42.
 *
 * The `targets` map is derived per model *inside* the adapter, so a nested
 * relation's `where` is typed against the relation's target rather than its
 * parent; that is what makes the cross-type check trustworthy.
 */
let adapter: SequelizeAdapter;
let db: Ormize;

beforeAll(async () => {
  adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
  db = new Ormize().registerAdapter(adapter);
  await db.addDefinition({
    name: "Owner",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "hasMany", model: "Thing", name: "things", options: { foreignKey: "ownerId" },
    }],
  });
  await db.addDefinition({
    name: "Thing",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "belongsTo", model: "Owner", name: "owner", options: { foreignKey: "ownerId" },
    }],
  });
  await db.initialise();
  await db.sync();
});

describe("replaceIdInWhere - type-checked decoding", () => {
  it("decodes a foreign key against the relationship's target", () => {
    expect(adapter.replaceIdInWhere({ ownerId: toGlobalId("Owner", "7") }, "Thing"))
      .toEqual({ ownerId: "7" });
  });

  it("leaves a foreign key alone when the id names another type", () => {
    const wrong = toGlobalId("Thing", "7");
    expect(adapter.replaceIdInWhere({ ownerId: wrong }, "Thing")).toEqual({ ownerId: wrong });
  });

  it("keeps the target through an operator wrapper", () => {
    const right = toGlobalId("Owner", "7");
    const wrong = toGlobalId("Thing", "7");
    expect(adapter.replaceIdInWhere({ ownerId: { in: [right, wrong] } }, "Thing"))
      .toEqual({ ownerId: { in: ["7", wrong] } });
  });

  it("checks a primary key against the model's own name", () => {
    expect(adapter.replaceIdInWhere({ id: toGlobalId("Thing", "7") }, "Thing")).toEqual({ id: "7" });
    const wrong = toGlobalId("Owner", "7");
    expect(adapter.replaceIdInWhere({ id: wrong }, "Thing")).toEqual({ id: wrong });
  });
});

describe("replaceIdInWhere - alternative codecs", () => {
  const codec = prefixIdCodec({ prefixes: { Owner: "own_", Thing: "thg_" } });

  it("decodes with the supplied codec instead of the relay default", () => {
    expect(adapter.replaceIdInWhere({ ownerId: "own_7" }, "Thing", undefined, { codec }))
      .toEqual({ ownerId: "7" });
    // ...and the relay id is now the unrecognised one
    const relay = toGlobalId("Owner", "7");
    expect(adapter.replaceIdInWhere({ ownerId: relay }, "Thing", undefined, { codec }))
      .toEqual({ ownerId: relay });
  });

  it("still refuses a cross-type id under a custom codec", () => {
    expect(adapter.replaceIdInWhere({ ownerId: "thg_7" }, "Thing", undefined, { codec }))
      .toEqual({ ownerId: "thg_7" });
  });

  it("is the identity under rawIdCodec", () => {
    expect(adapter.replaceIdInWhere({ ownerId: "7" }, "Thing", undefined, { codec: rawIdCodec() }))
      .toEqual({ ownerId: "7" });
  });
});

describe("replaceIdInArgs / replaceIdInInclude - translation reaches every hop", () => {
  const codec = prefixIdCodec({ prefixes: { Owner: "own_", Thing: "thg_" } });

  it("carries the codec into args.where", () => {
    expect(adapter.replaceIdInArgs({ where: { ownerId: "own_7" } }, "Thing", undefined, { codec }))
      .toEqual({ where: { ownerId: "7" } });
  });

  /** one `things` hop off `Owner`, as the engine carries it */
  const thingsInclude = (where: AdapterWhere): IncludeMap[] =>
    [{ things: { target: "Thing", associationType: "hasMany", where } }];

  it("types a nested include's where against the relation's target, not the parent", () => {
    const include = adapter.replaceIdInInclude(
      thingsInclude({ ownerId: "own_7" }),
      "Owner",
      undefined,
      { codec },
    );
    expect(include).toEqual(thingsInclude({ ownerId: "7" }));
  });

  it("leaves a nested include's cross-type id alone", () => {
    const include = adapter.replaceIdInInclude(
      thingsInclude({ ownerId: "thg_7" }),
      "Owner",
      undefined,
      { codec },
    );
    expect(include).toEqual(thingsInclude({ ownerId: "thg_7" }));
  });
});
