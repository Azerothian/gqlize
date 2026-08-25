import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { ScopeDeniedError } from "@azerothian/ormize/scope";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { scopeAware, unscoped } from "@azerothian/utilize/gate";
import ValkeyAdapter from "../src";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { makeClient, flush, shutdown } from "./helper/redis";

// Row-level scope on an adapter with **no enforcement layer of its own**.
//
// On sequelize the scope is imposed twice — once by the engine and once by the
// model hooks below it (§13) — and either half alone still passes most of the
// suite. Here there is only the engine: valkey ignores hooks entirely, so every
// test in this file fails if the merge in `resolveFindAll` / `processUpdate` /
// `processDelete` / `processInputs` is removed. That is the point of the file.
//
// It is also where the two failure modes the issue's own review turned up are
// visible, because both are properties of *this* adapter's query planner: a
// scope clause colliding with a caller clause on a non-indexed field (F1), and
// a scope this backend cannot express at all (F2).

let client: Awaited<ReturnType<typeof makeClient>>;

// `ownerId` is indexed, so a scope over it resolves without a keyspace scan.
// `secret` deliberately is not: a condition on it lands in the in-memory
// residual, which is the half of the query plan F1 is about.
const DocDef = {
  name: "Doc",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    ownerId: { type: DataTypes.String, index: true },
    name: { type: DataTypes.String },
    secret: { type: DataTypes.String },
  },
  options: {},
};

async function buildOrm(scope?: ScopePredicate) {
  const orm = new Ormize({ permission: scope ? { scope } : undefined });
  const adapter = new ValkeyAdapter({ prefix: "scope" }, client);
  orm.registerAdapter(adapter, "valkey");
  await orm.addDefinition(DocDef);
  await orm.initialise();
  await orm.sync();
  return { orm, adapter };
}

type Adapter = Awaited<ReturnType<typeof buildOrm>>["adapter"];
type Row = { name: string; ownerId: string; secret: string };

// Seeded through the adapter rather than the manager: these rows include ones
// the scope under test forbids, and a create that went through the engine would
// have the scope applied to it.
async function seed(adapter: Adapter) {
  const create = adapter.getCreateFunction("Doc");
  await create({ ownerId: "u1", name: "mine-1", secret: "no" });
  await create({ ownerId: "u1", name: "mine-2", secret: "yes" });
  await create({ ownerId: "u2", name: "theirs", secret: "no" });
}

const names = (rows: unknown[]) => (rows as Row[]).map((r) => r.name).sort();
const ownedBy = (id: string): ScopePredicate => () => ({ where: { ownerId: { eq: id } } });
const ctx = (id: string) => ({ user: { id } });

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("valkey adapter — row-level scope, reads", () => {
  it("narrows the root list and the total together", async () => {
    const { orm, adapter } = await buildOrm(ownedBy("u1"));
    await seed(adapter);
    const { total, models } = await orm.resolveFindAll("Doc", null, {}, ctx("u1"));
    expect(names(models)).toEqual(["mine-1", "mine-2"]);
    expect(total).toEqual(2);
  });

  it("imposes nothing when the predicate returns undefined", async () => {
    const { orm, adapter } = await buildOrm(() => undefined);
    await seed(adapter);
    // Absent opinion means unscoped, and the asymmetry with `false` below is the
    // whole fail-closed contract. Worth pinning per adapter: this is the
    // direction a merge bug fails open in.
    const { total } = await orm.resolveFindAll("Doc", null, {}, ctx("u1"));
    expect(total).toEqual(3);
  });

  it("returns an empty page — not every row — when the scope denies outright", async () => {
    const { orm, adapter } = await buildOrm(() => false);
    await seed(adapter);
    const { total, models } = await orm.resolveFindAll("Doc", null, {}, ctx("u1"));
    expect(models).toEqual([]);
    expect(total).toEqual(0);
  });

  it("keeps both clauses when the scope and the caller constrain the same non-indexed field (F1)", async () => {
    const { orm, adapter } = await buildOrm(
      () => ({ where: { ownerId: { eq: "u1" }, secret: { eq: "no" } } }),
    );
    await seed(adapter);
    // Neither clause is index-resolvable, so both land in the residual the
    // adapter refines in memory. Carrying that residual as one flat object —
    // issue #44 — kept whichever branch was merged last and silently dropped
    // the other, which under a scope is a row-level bypass rather than a wrong
    // answer. Each `and` branch names `ownerId` because the adapter refuses a
    // branch with no indexed field at all.
    const { total, models } = await orm.resolveFindAll(
      "Doc", null, { where: { ownerId: { eq: "u1" }, secret: { eq: "yes" } } }, ctx("u1"),
    );
    expect(models).toEqual([]);
    expect(total).toEqual(0);
  });

  it("surfaces a configuration error rather than an empty page for a scope it cannot index (F2)", async () => {
    const { orm, adapter } = await buildOrm(
      () => ({ where: { or: [{ ownerId: { eq: "u1" } }, { secret: { eq: "public" } }] } }),
    );
    await seed(adapter);
    // This adapter cannot resolve an `or` branch that is not fully indexed, and
    // there is no scan to fall back on. A scope it cannot express is a
    // deployment misconfiguration, so it has to be loud: swallowing the throw
    // into an empty page would read as "you own nothing" forever, and the
    // fail-closed path would be hiding the bug that caused it.
    await expect(orm.resolveFindAll("Doc", null, {}, ctx("u1"))).rejects.toThrow(/Valkey adapter/);
  });
});

describe("valkey adapter — row-level scope, writes", () => {
  it("narrows a bulk update to the rows the caller owns", async () => {
    const { orm, adapter } = await buildOrm(ownedBy("u1"));
    await seed(adapter);
    await orm.processUpdate("Doc", null, { input: { name: "renamed" }, where: {} }, ctx("u1"));
    expect(names(await adapter.findAll("Doc", {}))).toEqual(["renamed", "renamed", "theirs"]);
  });

  it("will not update a row the caller cannot see, even by id", async () => {
    const { orm, adapter } = await buildOrm(ownedBy("u1"));
    await seed(adapter);
    const [theirs] = await adapter.findAll("Doc", { where: { ownerId: { eq: "u2" } } }) as { id: string }[];
    const results = await orm.processUpdate(
      "Doc", null, { input: { name: "hijacked" }, where: { id: { eq: theirs.id } } }, ctx("u1"),
    );
    expect(results).toEqual([]);
    expect(names(await adapter.findAll("Doc", {}))).toEqual(["mine-1", "mine-2", "theirs"]);
  });

  it("will not select a row the caller cannot see", async () => {
    const { orm, adapter } = await buildOrm(ownedBy("u1"));
    await seed(adapter);
    const [theirs] = await adapter.findAll("Doc", { where: { ownerId: { eq: "u2" } } }) as { id: string }[];
    // `select` writes no field of its own, so it reads like a query — but it
    // applies relationship sub-mutations to everything its filter matches, which
    // makes it a write with a `where`. A layer that scoped only update and
    // delete would leave this one open.
    expect(await orm.processSelect(
      "Doc", null, { input: {}, where: { id: { eq: theirs.id } } }, ctx("u1"),
    )).toEqual([]);
  });

  it("narrows a bulk delete to the rows the caller owns", async () => {
    const { orm, adapter } = await buildOrm(ownedBy("u1"));
    await seed(adapter);
    await orm.processDelete("Doc", null, {}, ctx("u1"));
    expect(names(await adapter.findAll("Doc", {}))).toEqual(["theirs"]);
  });

  it("forces the owning field on create", async () => {
    const { orm } = await buildOrm(
      () => ({ where: { ownerId: { eq: "u1" } }, set: { ownerId: "u1" } }),
    );
    const [row] = await orm.processCreate("Doc", null, { input: { name: "fresh" } }, ctx("u1")) as Row[];
    expect(row.ownerId).toEqual("u1");
  });

  it("denies a create whose forged value disagrees with the scope", async () => {
    const { orm, adapter } = await buildOrm(
      () => ({ where: { ownerId: { eq: "u1" } }, set: { ownerId: "u1" } }),
    );
    await expect(
      orm.processCreate("Doc", null, { input: { name: "forged", ownerId: "u2" } }, ctx("u1")),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(await adapter.findAll("Doc", {})).toEqual([]);
  });
});

describe("valkey - row-level scope, the surfaces the engine cannot reach (§12)", () => {
  // Decision 7 and decision 9 are the same rule read against different backends,
  // and this is the half that cannot be tested on sequelize. There a class
  // method that ignores the scope still has §13's model hooks underneath it, so
  // the build warns. Here there is nothing underneath at all — the engine merge
  // is the only enforcement this adapter has ever had — so the same method is a
  // hole, and the build refuses.
  async function buildWithMethods(classMethods: {[name: string]: unknown}) {
    const orm = new Ormize({ permission: { scope: ownedBy("u1") } });
    orm.registerAdapter(new ValkeyAdapter({ prefix: "scope" }, client), "valkey");
    await orm.addDefinition(Object.assign({}, DocDef, { classMethods }) as never);
    await orm.initialise();
    return orm;
  }

  it("refuses to build an unannotated class method", async () => {
    await expect(buildWithMethods({ tally: () => 1 }))
      .rejects.toThrow(/Doc\.tally \(class method\)/);
  });

  it("still takes the written admission", async () => {
    // The escape hatch is not adapter-specific: what changes by backend is how
    // loudly the *absence* of one is reported, not whether one is accepted.
    await expect(buildWithMethods({ tally: unscoped(() => 1) })).resolves.toBeDefined();
  });

  it("still takes the claim that the method applies the scope itself", async () => {
    await expect(buildWithMethods({ tally: scopeAware(() => 1) })).resolves.toBeDefined();
  });
});

describe("valkey - row-level scope, the extend surface (§12)", () => {
  // `options.extend.query` is a gqlize surface, but the audit behind it is an
  // ormize method — decision 2 keeps the schema builder from reading a
  // resolution-time key, so it hands over the field map and is told whether the
  // build may proceed. Which makes this the layer the rule is testable at, and
  // the only one where a backend with no hook layer can be put underneath it.
  async function buildOrm() {
    const orm = new Ormize({ permission: { scope: ownedBy("u1") } });
    orm.registerAdapter(new ValkeyAdapter({ prefix: "scope" }, client), "valkey");
    await orm.addDefinition(DocDef);
    await orm.initialise();
    return orm;
  }

  it("refuses an unannotated extend field", async () => {
    const orm = await buildOrm();
    expect(() => orm.auditExtendSurfaces("query", { recentDocs: { resolve: () => 1 } }))
      .toThrow(/query\.recentDocs \(extend field\)/);
  });

  it("takes the written admission here too", async () => {
    const orm = await buildOrm();
    expect(() => orm.auditExtendSurfaces("query", { health: unscoped({ resolve: () => 1 }) }))
      .not.toThrow();
  });

  it("refuses even when a backend that does enforce is also registered", async () => {
    // The rule is *every* adapter, not the ones with scoped models. An extend
    // field holds the orm and can read anything on it, so a deployment mixing an
    // adapter with a hook layer and one without has a surface that reaches a
    // model with nothing underneath it — and a warning there would be a warning
    // about the wrong half.
    const orm = await buildOrm();
    orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    expect(() => orm.auditExtendSurfaces("query", { recentDocs: { resolve: () => 1 } }))
      .toThrow(/query\.recentDocs \(extend field\)/);
  });

  it("says nothing when no row-level scope is configured", async () => {
    const orm = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "scope" }, client), "valkey");
    await orm.addDefinition(DocDef);
    await orm.initialise();
    expect(() => orm.auditExtendSurfaces("query", { recentDocs: { resolve: () => 1 } }))
      .not.toThrow();
  });
});
