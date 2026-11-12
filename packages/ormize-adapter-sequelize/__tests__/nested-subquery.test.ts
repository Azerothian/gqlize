import { DataTypes } from "sequelize";
import type { IncludeOptions, Model } from "sequelize";
import { describe, expect, it } from "@jest/globals";

import SequelizeAdapter from "../src";
import { keepNestedJoinsOutOfSubQuery } from "../src/utils/nested-subquery";
import { dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";

// #70. Sequelize 6 marks a required include `subQuery` whenever an ancestor is
// required, even when that ancestor is a collection joined *outside* the
// paginated subquery, and the SQL then joins through a table that is not there.
// Each shape below failed with `no such column` before the adapter's
// `beforeFindAfterOptions` hook.

type Named = Model & { name: string };

async function build() {
  // The adapter's own Sequelize instance: what proves the hook is installed on
  // every instance the adapter creates, not just on models it defines itself.
  const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig({ logging: false })));
  const { sequelize } = adapter;
  const define = (name: string) =>
    sequelize.define<Named>(name, { name: DataTypes.STRING }, { timestamps: false });
  const Kind = define("Kind");
  const Type = define("Type");
  const Ext = define("Ext");
  const Task = define("Task");
  const Owner = define("Owner");
  Type.belongsTo(Kind, { as: "kind", foreignKey: "kindId" });
  Ext.belongsTo(Type, { as: "type", foreignKey: "typeId" });
  Task.hasMany(Ext, { as: "exts", foreignKey: "taskId" });
  Task.belongsToMany(Ext, { as: "links", through: "task_links", foreignKey: "taskId", otherKey: "extId" });
  Task.belongsTo(Owner, { as: "owner", foreignKey: "ownerId" });
  Owner.hasMany(Ext, { as: "ownedExts", foreignKey: "ownerId" });
  await sequelize.sync();

  const kind = await Kind.create({ name: "k" });
  const kinded = await Type.create({ name: "test", kindId: kind.get("id") });
  const kindless = await Type.create({ name: "test" });
  const other = await Type.create({ name: "other" });
  const o1 = await Owner.create({ name: "o1" });
  const o2 = await Owner.create({ name: "o2" });
  const a = await Task.create({ name: "A", ownerId: o1.get("id") });
  const b = await Task.create({ name: "B", ownerId: o2.get("id") });
  await Task.create({ name: "C" });
  const e1 = await Ext.create({ name: "e1", typeId: kinded.get("id"), taskId: a.get("id"), ownerId: o1.get("id") });
  const e2 = await Ext.create({ name: "e2", typeId: kindless.get("id"), taskId: b.get("id"), ownerId: o2.get("id") });
  await Ext.create({ name: "e3", typeId: other.get("id"), taskId: a.get("id") });
  await (a as unknown as { addLinks(e: unknown[]): Promise<void> }).addLinks([e1]);
  await (b as unknown as { addLinks(e: unknown[]): Promise<void> }).addLinks([e2]);
  return { Kind, Type, Ext, Task, Owner };
}

const required = (include: IncludeOptions): IncludeOptions => ({ ...include, required: true });

describe("required includes under a required collection (#70)", () => {
  it("filters parents through a required hasMany with a required child", async() => {
    const { Type, Ext, Task } = await build();
    const rows = await Task.findAll({
      limit: 10,
      include: [required({ model: Ext, as: "exts", include: [required({ model: Type, as: "type", where: { name: "other" } })] })],
    }) as (Named & { exts: Named[] })[];
    expect(rows.map((r) => r.name)).toEqual(["A"]);
    // The INNER JOIN filters the collection too, as it does without a limit.
    expect(rows[0].exts.map((e) => e.name)).toEqual(["e3"]);
  });

  it("filters parents through a required belongsToMany, two levels down", async() => {
    const { Kind, Type, Ext, Task } = await build();
    const rows = await Task.findAll({
      limit: 10,
      include: [required({ model: Ext, as: "links", include: [
        required({ model: Type, as: "type", include: [required({ model: Kind, as: "kind" })] }),
      ] })],
    });
    expect(rows.map((r) => r.name)).toEqual(["A"]);
  });

  it("filters parents through a required collection beneath a required belongsTo", async() => {
    const { Kind, Type, Ext, Task, Owner } = await build();
    const rows = await Task.findAll({
      limit: 10,
      include: [required({ model: Owner, as: "owner", include: [
        required({ model: Ext, as: "ownedExts", include: [
          required({ model: Type, as: "type", include: [required({ model: Kind, as: "kind" })] }),
        ] }),
      ] })],
    });
    expect(rows.map((r) => r.name)).toEqual(["A"]);
  });

  it("still counts the page in parents", async() => {
    const { Type, Ext, Task } = await build();
    const page = (order: "ASC" | "DESC") => Task.findAll({
      limit: 1,
      order: [["id", order]],
      include: [required({ model: Ext, as: "exts", include: [required({ model: Type, as: "type", where: { name: "test" } })] })],
    });
    expect((await page("ASC")).map((r) => r.name)).toEqual(["A"]);
    expect((await page("DESC")).map((r) => r.name)).toEqual(["B"]);
  });
});

describe("keepNestedJoinsOutOfSubQuery", () => {
  type Node = { subQuery: boolean; subQueryFilter?: boolean; required?: boolean; include?: Node[] };

  it("only moves a required child whose parent is outside the subquery", () => {
    const options: { include: Node[] } = {
      include: [
        // A required collection: outside the subquery, so its child must be too.
        { required: true, subQuery: false, include: [{ required: true, subQuery: true, include: [{ required: true, subQuery: true }] }] },
        // A required belongsTo: inside, and its child may stay inside with it.
        { required: true, subQuery: true, include: [{ required: true, subQuery: true }] },
      ],
    };
    keepNestedJoinsOutOfSubQuery(options);
    expect(options.include[0].include?.[0].subQuery).toBe(false);
    expect(options.include[0].include?.[0].include?.[0].subQuery).toBe(false);
    expect(options.include[1].subQuery).toBe(true);
    expect(options.include[1].include?.[0].subQuery).toBe(true);
  });

  it("keeps an include that is not required — and all beneath it — off the root's filter", () => {
    // `required` is local: below a non-required level it may remove that
    // level's rows, never the roots. Sequelize placed such a subtree in the
    // paginated subquery or on the root's EXISTS filter because a descendant
    // was required.
    const options: { include: Node[] } = {
      include: [
        { required: false, subQuery: true, include: [
          { required: true, subQuery: false, subQueryFilter: true, include: [{ required: true, subQuery: true }] },
        ] },
      ],
    };
    keepNestedJoinsOutOfSubQuery(options);
    const [optional] = options.include;
    const child = optional.include?.[0];
    expect(optional.subQuery).toBe(false);
    expect(optional.subQueryFilter).toBe(false);
    expect(child?.subQueryFilter).toBe(false);
    expect(child?.include?.[0].subQuery).toBe(false);
  });

  it("leaves a query with no includes alone", () => {
    expect(() => keepNestedJoinsOutOfSubQuery({})).not.toThrow();
  });
});
