import {graphql} from "graphql";
import Sequelize from "sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import {validateResult} from "./helper";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";

// Tracks child-model hook firing so we can assert the count-only path runs a
// count (beforeCount/afterCount) instead of a findAll (beforeFind).
const calls = { childBeforeFind: 0, childAfterFind: 0, childBeforeCount: 0, childAfterCount: 0 };

async function build(afterCountTransform?: (total: number) => number) {
  calls.childBeforeFind = 0;
  calls.childAfterFind = 0;
  calls.childBeforeCount = 0;
  calls.childAfterCount = 0;
  const db = new Database();
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  db.addDefinition({
    name: "CParent",
    define: { name: { type: Sequelize.STRING, allowNull: false } },
    relationships: [{
      type: "hasMany", model: "CChild", name: "children",
      options: { as: "children", foreignKey: "parentId" },
    }],
  } as any);
  db.addDefinition({
    name: "CChild",
    define: { name: { type: Sequelize.STRING, allowNull: false } },
    relationships: [{
      type: "belongsTo", model: "CParent", name: "parent",
      options: { foreignKey: "parentId" },
    }],
    options: {
      hooks: {
        beforeFind(options: any) { calls.childBeforeFind++; return options; },
        afterFind(instances: any) { calls.childAfterFind++; return instances; },
        beforeCount(options: any) { calls.childBeforeCount++; return options; },
        afterCount(total: number) {
          calls.childAfterCount++;
          return afterCountTransform ? afterCountTransform(total) : total;
        },
      },
    },
  } as any);
  await db.initialise();
  await db.sync();
  return db;
}

describe("count-only resolution (select total without edges)", () => {
  it("runs a count (beforeCount + afterCount) instead of a findAll for a nested total", async () => {
    const db = await build();
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });
    await CChild.create({ name: "c2", parentId: p.get("id") });

    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query { models { CParent { edges { node { name children { total } } } } } }`,
    })) as any;
    validateResult(result);

    expect(result.data.models.CParent.edges[0].node.children.total).toEqual(2);
    expect(calls.childBeforeCount).toBeGreaterThanOrEqual(1);
    expect(calls.childAfterCount).toBeGreaterThanOrEqual(1);
    // no rows fetched for the children -> the child model's beforeFind never fired
    expect(calls.childBeforeFind).toEqual(0);
  });

  it("afterCount can transform the reported total", async () => {
    const db = await build((total) => total * 10);
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });
    await CChild.create({ name: "c2", parentId: p.get("id") });

    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query { models { CParent { edges { node { children { total } } } } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CParent.edges[0].node.children.total).toEqual(20);
  });

  it("selecting edges fetches rows (findAll), not the count-only path", async () => {
    const db = await build();
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });

    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query { models { CParent { edges { node { children { edges { node { name } } } } } } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CParent.edges[0].node.children.edges).toHaveLength(1);
    // rows were fetched -> child beforeFind fired (JOIN eager load)
    expect(calls.childBeforeFind).toBeGreaterThanOrEqual(1);
  });

  it("fires child beforeFind + afterFind exactly once on a JOIN-loaded relation (no double-fire)", async () => {
    const db = await build();
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });
    await CChild.create({ name: "c2", parentId: p.get("id") });

    const schema = await createSchema(db);
    // no pagination -> children JOIN-loaded -> manual beforeFind + afterFind, once each
    const result = (await graphql({
      schema,
      source: `query { models { CParent { edges { node { children { edges { node { name } } } } } } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CParent.edges[0].node.children.edges).toHaveLength(2);
    expect(calls.childBeforeFind).toEqual(1);
    expect(calls.childAfterFind).toEqual(1);
  });

  it("fires child hooks once via native path on a separate:true (paginated) relation", async () => {
    const db = await build();
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });
    await CChild.create({ name: "c2", parentId: p.get("id") });

    const schema = await createSchema(db);
    // first:1 -> separate:true -> native beforeFind/afterFind (not manual), once each
    const result = (await graphql({
      schema,
      source: `query { models { CParent { edges { node { children(first: 1) { edges { node { name } } } } } } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CParent.edges[0].node.children.edges).toHaveLength(1);
    expect(calls.childBeforeFind).toEqual(1);
    expect(calls.childAfterFind).toEqual(1);
  });

  it("fires child hooks once when separate:true is forced without pagination (no double-fire)", async () => {
    const db = await build();
    const { CParent, CChild } = db.models as any;
    const p = await CParent.create({ name: "p1" });
    await CChild.create({ name: "c1", parentId: p.get("id") });
    await CChild.create({ name: "c2", parentId: p.get("id") });

    const schema = await createSchema(db);
    // explicit separate:true (no pagination) -> loaded via a separate query, which
    // fires the child find hooks natively; the eager post-pass must NOT fire them
    // again.
    const result = (await graphql({
      schema,
      source: `query { models {
        CParent(include: { children: { separate: true } }) {
          edges { node { children { edges { node { name } } } } }
        }
      } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CParent.edges[0].node.children.edges).toHaveLength(2);
    expect(calls.childBeforeFind).toEqual(1);
    expect(calls.childAfterFind).toEqual(1);
  });

  it("top-level total-only runs a count + afterCount", async () => {
    const db = await build();
    const { CChild } = db.models as any;
    await CChild.create({ name: "c1" });
    await CChild.create({ name: "c2" });
    await CChild.create({ name: "c3" });

    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query { models { CChild { total } } }`,
    })) as any;
    validateResult(result);
    expect(result.data.models.CChild.total).toEqual(3);
    expect(calls.childBeforeCount).toBeGreaterThanOrEqual(1);
    expect(calls.childAfterCount).toBeGreaterThanOrEqual(1);
    expect(calls.childBeforeFind).toEqual(0); // no rows fetched
  });
});
