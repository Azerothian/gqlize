/**
 * belongsToMany `through` from a `select` activity. Its `input` reaches the
 * relationship verbs unvalidated, so the engine checks a `through` payload
 * against the call's own permission bag, and a refusal surfaces as a
 * non-retryable Forbidden failure like every other guard here.
 */
import { describe, expect, it } from "@jest/globals";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import type { Permission } from "@azerothian/utilize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";
import { createActivities } from "../src/activities";
import { ErrorType } from "../src/workflow-types";
import { expectFailure } from "./helper";

async function buildOrm(): Promise<Ormize> {
  const orm = new Ormize();
  const adapter = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(adapter);
  orm.registerAdapter(adapter, testDialect());
  const through = { model: "PostTag" };
  await orm.addDefinition({ name: "Post", define: { title: { type: DataTypes.STRING } }, options: { timestamps: false },
    relationships: [{ type: "belongsToMany", model: "Tag", name: "tags", options: { through, foreignKey: "postId", otherKey: "tagId" } }] });
  await orm.addDefinition({ name: "Tag", define: { name: { type: DataTypes.STRING } }, options: { timestamps: false },
    relationships: [{ type: "belongsToMany", model: "Post", name: "posts", options: { through, foreignKey: "tagId", otherKey: "postId" } }] });
  await orm.addDefinition({ name: "PostTag", define: { sortOrder: { type: DataTypes.INTEGER }, label: { type: DataTypes.STRING } }, options: { timestamps: false } });
  await orm.initialise();
  await orm.sync();
  await orm.processCreate("Post", null, { input: { title: "p1" } }, {});
  await orm.processCreate("Tag", null, { input: { name: "t1" } }, {});
  return orm;
}

const permission: Permission = {
  mutationCreateInput: (model: string, field: string) => !(model === "PostTag" && field === "label"),
};
const context = { userId: "u1", role: "admin" };
const tagWith = (through: Record<string, unknown>) => ({
  context, where: { title: { eq: "p1" } },
  input: { tags: { add: [{ where: { name: { eq: "t1" } }, through }] } },
});

describe("temporalize - belongsToMany through", () => {
  it("writes a permitted join column", async () => {
    const orm = await buildOrm();
    const acts = createActivities(orm, { resolvePermission: () => permission });
    await acts["Post.select"](tagWith({ sortOrder: 4 }));
    const rows = await orm.getModelAdapter("PostTag").findAll("PostTag", {}) as { get: (k: string) => unknown }[];
    expect(rows.map((r) => r.get("sortOrder"))).toEqual([4]);
  });

  it("refuses a column the call's permission denies", async () => {
    const orm = await buildOrm();
    const acts = createActivities(orm, { resolvePermission: () => permission });
    await expectFailure(acts["Post.select"](tagWith({ label: "x" })), ErrorType.Forbidden);
  });

  it("refuses a join key even with no permission configured", async () => {
    const orm = await buildOrm();
    const acts = createActivities(orm);
    await expectFailure(acts["Post.select"](tagWith({ postId: 99 })), ErrorType.Forbidden);
  });
});
