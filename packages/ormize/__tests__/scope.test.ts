import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { describe, it, expect, jest } from "@jest/globals";
import Sequelize from "sequelize";
import Events from "../src/events";
import type { Permission, ScopePredicate } from "@azerothian/utilize/gate";
import { ScopeDeniedError } from "../src/scope";

// One flat model. `ownerId` is an ordinary column rather than a relationship's
// foreign key, so it survives `isStructurallyWritable` — which is what lets the
// forged-value tests send it at all. A scope over a real FK is the easier case:
// the allow-list has already dropped the client's value before `set` runs.
async function buildOrm(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
  before?: (req: BeforeRequest) => unknown;
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({
    permission,
    onScopeMiss: options.onScopeMiss,
  });
  db.registerAdapter(
    new SequelizeAdapter({}, { dialect: "sqlite", logging: false }),
    "sqlite",
  );
  await db.addDefinition({
    name: "Doc",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      ownerId: { type: Sequelize.INTEGER, allowNull: true },
    },
    options: { timestamps: false, tableName: "docs" },
    before: options.before,
  });
  await db.initialise();
  await db.sync();
  return db;
}

async function seed(db: Orm) {
  await db.models.Doc.bulkCreate([
    { name: "mine-1", ownerId: 1 },
    { name: "mine-2", ownerId: 1 },
    { name: "theirs", ownerId: 2 },
  ]);
}

/** "Only the rows you own", the canonical scope. */
const ownedBy = (id: number): ScopePredicate => () => ({ where: { ownerId: { eq: id } } });

const ctx = (id: number) => ({ user: { id } });

type Orm = Awaited<ReturnType<typeof buildOrm>>;
/** Just the slice of a `definition.before` request these tests read. */
type BeforeRequest = { type: unknown; params: { where?: unknown } };
/** Rows come back as opaque adapter instances; these are the columns read back. */
type NamedRow = { name: string };
type OwnedRow = { ownerId: number };

describe("ormize - row-level scope, reads", () => {
  it("narrows the root list and the count together", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect((models as NamedRow[]).map((m) => m.name).sort()).toEqual(["mine-1", "mine-2"]);
    // `total` is the point of merging before `processListArgsToOptions`: a scope
    // applied only to the fetch leaves the count reporting rows the caller may
    // not see, which is the oracle the scope exists to close.
    expect(total).toEqual(2);
  });

  it("returns an empty page — not every row — when the scope denies outright", async () => {
    const db = await buildOrm({ scope: () => false });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect(models).toEqual([]);
    expect(total).toEqual(0);
  });

  it("imposes nothing when the predicate returns undefined", async () => {
    const db = await buildOrm({ scope: () => undefined });
    await seed(db);
    const { total } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    // Absent opinion means unscoped. The asymmetry with `false` above is the
    // whole fail-closed contract, and it is easy to invert by accident.
    expect(total).toEqual(3);
  });

  it("AND-s the scope with the caller's filter on the same field (F10)", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    // The caller names the very field the scope constrains. A merge that spread
    // instead of wrapping would keep whichever was written second — here, that
    // would hand them someone else's rows.
    const { total, models } = await db.resolveFindAll(
      "Doc", null, { where: { ownerId: { eq: 2 } } }, ctx(1),
    );
    expect(models).toEqual([]);
    expect(total).toEqual(0);
  });

  it("survives a `definition.before` that reassigns params.where (F3)", async () => {
    const db = await buildOrm({
      scope: ownedBy(1),
      before(req: BeforeRequest) {
        if (req.type === Events.QUERY) {
          // Exactly what a deployment that did row filtering the old way looks
          // like: the hook owns `where` and overwrites whatever was there.
          req.params.where = {};
        }
        return req.params;
      },
    });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect((models as NamedRow[]).map((m) => m.name).sort()).toEqual(["mine-1", "mine-2"]);
    expect(total).toEqual(2);
  });

  it("resolves the predicate once per (model, operation) for a request (F7)", async () => {
    const scope = jest.fn(() => ({ where: { ownerId: { eq: 1 } } })) as unknown as ScopePredicate;
    const db = await buildOrm({ scope });
    await seed(db);
    const context = ctx(1);
    await db.resolveFindAll("Doc", null, {}, context);
    await db.resolveFindAll("Doc", null, {}, context);
    await db.resolveFindAll("Doc", null, {}, context);
    // Not an optimisation: a predicate that reads a database can answer
    // differently within one request, and a request scoped two ways is worse
    // than one scoped either way.
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it("does not serve one principal's decision to another", async () => {
    const db = await buildOrm({
      scope: (_defName, _operation, _options, context) =>
        ({ where: { ownerId: { eq: (context as { user: { id: number } }).user.id } } }),
    });
    await seed(db);
    const shared = { user: { id: 1 } };
    const first = await db.resolveFindAll("Doc", null, {}, shared);
    expect(first.total).toEqual(2);
    // A deployment that reuses one context object across principals must not get
    // the memoised answer, which is why the principal id is part of the key.
    shared.user = { id: 2 };
    const second = await db.resolveFindAll("Doc", null, {}, shared);
    expect(second.total).toEqual(1);
  });
});

describe("ormize - row-level scope, writes", () => {
  it("will not update a row the caller cannot see", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const theirs = await db.models.Doc.findOne({ where: { name: "theirs" } });
    const results = await db.processUpdate(
      "Doc", null, { input: { name: "hijacked" }, where: { id: { eq: theirs.id } } }, ctx(1),
    );
    // A read scope alone is a false sense of security: the caller cannot see the
    // row but can still name its id.
    expect(results).toEqual([]);
    await theirs.reload();
    expect(theirs.name).toEqual("theirs");
  });

  it("still updates a row the caller does own", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    const results = await db.processUpdate(
      "Doc", null, { input: { name: "renamed" }, where: { id: { eq: mine.id } } }, ctx(1),
    );
    expect(results).toHaveLength(1);
    await mine.reload();
    expect(mine.name).toEqual("renamed");
  });

  it("will not delete a row the caller cannot see", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const theirs = await db.models.Doc.findOne({ where: { name: "theirs" } });
    await db.processDelete("Doc", null, { id: { eq: theirs.id } }, ctx(1));
    expect(await db.models.Doc.count({ where: { name: "theirs" } })).toEqual(1);
  });

  it("will not select a row the caller cannot see", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const theirs = await db.models.Doc.findOne({ where: { name: "theirs" } });
    // `select` writes no field, so it reads like a query; it applies relationship
    // sub-mutations to everything its filter matches, which makes it a write.
    const results = await db.processSelect(
      "Doc", null, { input: {}, where: { id: { eq: theirs.id } } }, ctx(1),
    );
    expect(results).toEqual([]);
  });

  it("reports the same nothing a missing row reports, by default", async () => {
    const db = await buildOrm({ scope: () => false });
    await seed(db);
    expect(await db.processUpdate("Doc", null, { input: { name: "x" }, where: {} }, ctx(1))).toEqual([]);
    expect(await db.processDelete("Doc", null, {}, ctx(1))).toEqual([]);
    expect(await db.models.Doc.count()).toEqual(3);
  });

  it("refuses loudly instead when onScopeMiss is 'throw'", async () => {
    const db = await buildOrm({ scope: () => false, onScopeMiss: "throw" });
    await seed(db);
    await expect(
      db.processUpdate("Doc", null, { input: { name: "x" }, where: {} }, ctx(1)),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
  });

  it("keeps a denied read quiet even when writes are configured to throw", async () => {
    const db = await buildOrm({ scope: () => false, onScopeMiss: "throw" });
    await seed(db);
    // An empty page is what a caller with no matching rows already sees, so it
    // leaks nothing and there is no reason to trade that for a 403.
    const { total } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect(total).toEqual(0);
  });
});

describe("ormize - row-level scope, `set`", () => {
  it("forces the owning field on create", async () => {
    const db = await buildOrm({ scope: () => ({ set: { ownerId: 7 } }) });
    const [row] = await db.processCreate("Doc", null, { input: { name: "fresh" } }, ctx(7)) as OwnedRow[];
    expect(row.ownerId).toEqual(7);
  });

  it("denies a create whose forged value disagrees with the scope", async () => {
    const db = await buildOrm({ scope: () => ({ set: { ownerId: 7 } }) });
    await expect(
      db.processCreate("Doc", null, { input: { name: "forged", ownerId: 2 } }, ctx(7)),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    // Writing the safe value anyway is the tempting implementation, and it hides
    // a forged request behind a successful mutation.
    expect(await db.models.Doc.count()).toEqual(0);
  });

  it("accepts a client value that agrees with the scope", async () => {
    const db = await buildOrm({ scope: () => ({ set: { ownerId: 7 } }) });
    const [row] = await db.processCreate("Doc", null, { input: { name: "ok", ownerId: 7 } }, ctx(7)) as OwnedRow[];
    expect(row.ownerId).toEqual(7);
  });

  it("creates nothing when the scope denies creates outright", async () => {
    const db = await buildOrm({ scope: (_d, operation) => (operation === "create" ? false : undefined) });
    expect(await db.processCreate("Doc", null, { input: { name: "nope" } }, ctx(1))).toEqual([]);
    expect(await db.models.Doc.count()).toEqual(0);
  });

  it("re-forces the owning field on update, so a write cannot move a row out of scope (F6)", async () => {
    const db = await buildOrm({
      scope: () => ({ where: { ownerId: { eq: 1 } }, set: { ownerId: 1 } }),
    });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    await expect(
      db.processUpdate("Doc", null, { input: { ownerId: 2 }, where: { id: { eq: mine.id } } }, ctx(1)),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    await mine.reload();
    expect(mine.ownerId).toEqual(1);
  });

  it("scopes each operation independently", async () => {
    const seen: string[] = [];
    const db = await buildOrm({
      scope: (_defName, operation) => {
        seen.push(operation);
        return operation === "delete" ? false : { where: { ownerId: { eq: 1 } } };
      },
    });
    await seed(db);
    const context = ctx(1);
    await db.resolveFindAll("Doc", null, {}, context);
    await db.processDelete("Doc", null, {}, context);
    expect(seen).toEqual(["read", "delete"]);
    expect(await db.models.Doc.count()).toEqual(3);
  });
});
