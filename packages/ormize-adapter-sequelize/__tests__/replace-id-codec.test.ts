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
 *
 * An id that names the wrong type raises rather than being left undecoded — see
 * `packages/gqlize/src/utils/decode-id.ts` and #65. The assertions below check
 * the message, since a bare `toThrow()` would also pass on the wrong error.
 */
const mismatch = (field: string, expected: string, received: string) =>
  new RegExp(`"${field}" expects a "${expected}" id, but the id given is a "${received}" id`);
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
  // `Role -> RoleUser <- User` — #65. `belongsToMany` drops the join model's own
  // `id` and makes `roleId`/`userId` its *composite primary key*, so they are pk
  // and fk at once. Two shapes, because they resolve their target differently:
  // `RoleUser` declares the matching `belongsTo`s, `Tagging` declares nothing and
  // has to be resolved from the attribute's `references`.
  await db.addDefinition({
    name: "Role",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "belongsToMany", model: "User", name: "users",
      options: { through: "RoleUser", foreignKey: "roleId", otherKey: "userId" },
    }],
  });
  await db.addDefinition({
    name: "User",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "belongsToMany", model: "Role", name: "roles",
      options: { through: "RoleUser", foreignKey: "userId", otherKey: "roleId" },
    }],
  });
  await db.addDefinition({
    name: "RoleUser",
    define: { note: { type: Sequelize.STRING, allowNull: true } },
    relationships: [
      { type: "belongsTo", model: "Role", name: "role", options: { foreignKey: "roleId" } },
      { type: "belongsTo", model: "User", name: "user", options: { foreignKey: "userId" } },
    ],
  });
  await db.addDefinition({
    name: "Post",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "belongsToMany", model: "Tag", name: "tags",
      options: { through: "Tagging", foreignKey: "postId", otherKey: "tagId" },
    }],
  });
  await db.addDefinition({
    name: "Tag",
    define: { name: { type: Sequelize.STRING, allowNull: true } },
    relationships: [{
      type: "belongsToMany", model: "Post", name: "posts",
      options: { through: "Tagging", foreignKey: "tagId", otherKey: "postId" },
    }],
  });
  await db.addDefinition({
    name: "Tagging",
    define: { note: { type: Sequelize.STRING, allowNull: true } },
  });
  await db.initialise();
  await db.sync();
});

describe("replaceIdInWhere - type-checked decoding", () => {
  it("decodes a foreign key against the relationship's target", () => {
    expect(adapter.replaceIdInWhere({ ownerId: toGlobalId("Owner", "7") }, "Thing"))
      .toEqual({ ownerId: "7" });
  });

  it("raises when the id names another type", () => {
    expect(() => adapter.replaceIdInWhere({ ownerId: toGlobalId("Thing", "7") }, "Thing"))
      .toThrow(mismatch("Thing.ownerId", "Owner", "Thing"));
  });

  it("keeps the target through an operator wrapper", () => {
    const right = toGlobalId("Owner", "7");
    expect(adapter.replaceIdInWhere({ ownerId: { in: [right] } }, "Thing"))
      .toEqual({ ownerId: { in: ["7"] } });
    expect(() => adapter.replaceIdInWhere(
      { ownerId: { in: [right, toGlobalId("Thing", "7")] } }, "Thing",
    )).toThrow(mismatch("Thing.ownerId", "Owner", "Thing"));
  });

  it("checks a primary key against the model's own name", () => {
    expect(adapter.replaceIdInWhere({ id: toGlobalId("Thing", "7") }, "Thing")).toEqual({ id: "7" });
    expect(() => adapter.replaceIdInWhere({ id: toGlobalId("Owner", "7") }, "Thing"))
      .toThrow(mismatch("Thing.id", "Thing", "Owner"));
  });
});

/**
 * #65: a join model's foreign keys are also its primary key, and the target has
 * to win — the value in `RoleUser.userId` is a `User` key, whatever else the
 * column is.
 */
describe("replaceIdInWhere - a join model's keys are typed by what they point at", () => {
  it("targets both ends of a through model, not the through model itself", () => {
    expect(db.getGlobalKeyTargets("RoleUser")).toEqual({ roleId: "Role", userId: "User" });
  });

  it("resolves the targets from `references` when the join model declares no relationships", () => {
    expect(db.getGlobalKeyTargets("Tagging")).toEqual({ postId: "Post", tagId: "Tag" });
  });

  it("decodes a composite-primary-key foreign key against its target", () => {
    expect(adapter.replaceIdInWhere({ userId: toGlobalId("User", "7") }, "RoleUser"))
      .toEqual({ userId: "7" });
  });

  it("raises on the through model's own name, which used to be what it accepted", () => {
    expect(() => adapter.replaceIdInWhere({ userId: toGlobalId("RoleUser", "7") }, "RoleUser"))
      .toThrow(mismatch("RoleUser.userId", "User", "RoleUser"));
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
    expect(() => adapter.replaceIdInWhere({ ownerId: "thg_7" }, "Thing", undefined, { codec }))
      .toThrow(mismatch("Thing.ownerId", "Owner", "Thing"));
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

  it("raises on a nested include's cross-type id", () => {
    expect(() => adapter.replaceIdInInclude(
      thingsInclude({ ownerId: "thg_7" }),
      "Owner",
      undefined,
      { codec },
    )).toThrow(mismatch("Thing.ownerId", "Owner", "Thing"));
  });
});
