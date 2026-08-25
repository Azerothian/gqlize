import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let rawClient: Awaited<ReturnType<typeof makeClient>>;

// `kind` is indexed so every `where` below resolves without a scan; `title` and
// `rank` are not, so conditions on them land in the in-memory residual — which
// is what this file is about.
const Def = {
  name: "Doc",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    kind: { type: DataTypes.String, index: true },
    title: { type: DataTypes.String },
    rank: { type: DataTypes.Int },
  },
  options: {},
};

async function seed() {
  const adapter = new ValkeyAdapter({ prefix: "res" }, rawClient);
  await adapter.createModel(Def);
  const create = adapter.getCreateFunction("Doc");
  await create({ kind: "x", title: "a", rank: 1 });
  await create({ kind: "x", title: "b", rank: 9 });
  await create({ kind: "x", title: "c", rank: 5 });
  await create({ kind: "y", title: "a", rank: 7 });
  return adapter;
}

// Each `and` branch below independently names `kind`: the adapter refuses a
// branch with no indexed field (no keyspace scans), so that is not optional.
type Row = { kind: string; title: string; rank: number };
const titles = (rows: unknown[]) => (rows as Row[]).map((r) => r.title).sort();

beforeAll(async () => { rawClient = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(rawClient); });

describe("valkey adapter — AND-ed branches keep their own residual clauses", () => {
  it("an unsatisfiable AND over the same non-indexed field returns nothing", async () => {
    const adapter = await seed();
    // Both branches constrain `title`. Merging the residual into one object
    // drops the first and answers as if only `title = b` had been asked.
    const rows = await adapter.findAll("Doc", {
      where: { and: [{ kind: { eq: "x" }, title: { eq: "a" } }, { kind: { eq: "x" }, title: { eq: "b" } }] },
    });
    expect(rows).toEqual([]);
  });

  it("branch order is not load-bearing", async () => {
    const adapter = await seed();
    const rows = await adapter.findAll("Doc", {
      where: { and: [{ kind: { eq: "x" }, title: { eq: "b" } }, { kind: { eq: "x" }, title: { eq: "a" } }] },
    });
    expect(rows).toEqual([]);
  });

  it("a satisfiable AND across branches still returns its row", async () => {
    const adapter = await seed();
    const rows = await adapter.findAll("Doc", {
      where: { and: [{ kind: { eq: "x" }, title: { eq: "b" } }, { kind: { eq: "x" }, rank: { gt: 5 } }] },
    });
    expect(titles(rows)).toEqual(["b"]);
  });

  it("every branch narrows, none is discarded", async () => {
    const adapter = await seed();
    const rows = await adapter.findAll("Doc", {
      where: { and: [{ kind: { eq: "x" }, rank: { gt: 1 } }, { kind: { eq: "x" }, rank: { lt: 9 } }] },
    });
    expect(titles(rows)).toEqual(["c"]);
  });

  it("a residual on a partially-indexed field survives another branch's residual on the same field", async () => {
    const adapter = await seed();
    // `kind: {eq}` is index-resolvable; the sibling `like` is not, so it becomes
    // residual keyed on the *indexed* field — the collision the flat object hid.
    // Asserted both ways round: a merge that keeps only the last clause answers
    // one ordering correctly by luck.
    for (const branches of [
      [{ kind: { eq: "x", like: "%x%" } }, { kind: { eq: "x", like: "z%" } }],
      [{ kind: { eq: "x", like: "z%" } }, { kind: { eq: "x", like: "%x%" } }],
    ]) {
      expect(await adapter.findAll("Doc", { where: { and: branches } })).toEqual([]);
    }
  });

  it("sibling keys within one branch all survive", async () => {
    const adapter = await seed();
    const rows = await adapter.findAll("Doc", {
      where: { kind: { eq: "x", like: "%x%" }, title: { eq: "a" }, rank: { lt: 5 } },
    });
    expect(titles(rows)).toEqual(["a"]);
  });

  it("two `not` clauses in separate branches both apply", async () => {
    const adapter = await seed();
    const rows = await adapter.findAll("Doc", {
      where: {
        and: [
          { kind: { eq: "x" }, not: { title: { eq: "a" } } },
          { kind: { eq: "x" }, not: { title: { eq: "b" } } },
        ],
      },
    });
    expect(titles(rows)).toEqual(["c"]);
  });

  it("keeps refusing an `or` branch that is not fully index-resolvable", async () => {
    const adapter = await seed();
    await expect(adapter.findAll("Doc", {
      where: { or: [{ kind: { eq: "x" }, title: { eq: "a" } }, { kind: { eq: "y" } }] },
    })).rejects.toThrow(/fully index-resolvable/);
  });

  it("a relationship finder's merged filter does not swallow the caller's clauses", async () => {
    const adapter = await seed();
    // `createFunctionForFind` composes `{and: [callerWhere, fkFilter]}` via
    // `mergeFilterStatement` — the same shape ormize builds for a cross-adapter
    // relationship read.
    const find = adapter.createFunctionForFind("Doc")("x", "kind", false);

    const rows = await find({
      where: { and: [{ kind: { eq: "x" }, title: { eq: "a" } }, { kind: { eq: "x" }, title: { eq: "b" } }] },
    }) as unknown[];
    expect(rows).toEqual([]);

    const ok = await find({
      where: { and: [{ kind: { eq: "x" }, rank: { gt: 1 } }, { kind: { eq: "x" }, rank: { lt: 9 } }] },
    }) as unknown[];
    expect(titles(ok)).toEqual(["c"]);
  });
});
