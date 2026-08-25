import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { describe, it, expect, jest } from "@jest/globals";
import Sequelize from "sequelize";
import Events from "../src/events";
import type { Permission, ScopePredicate } from "@azerothian/utilize/gate";
import type { HookMap } from "../src/types";
import { ScopeDeniedError, ScopeEscapeError } from "../src/scope";

// One flat model. `ownerId` is an ordinary column rather than a relationship's
// foreign key, so it survives `isStructurallyWritable` — which is what lets the
// forged-value tests send it at all. A scope over a real FK is the easier case:
// the allow-list has already dropped the client's value before `set` runs.
async function buildOrm(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
  before?: (req: BeforeRequest) => unknown;
  hooks?: HookMap;
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
    hooks: options.hooks,
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

// A `Folder hasMany Doc` pair, so the nested-mutation verbs have a target model
// to reach. Only `Doc` is scoped: the verbs run against the *target*, and a
// scoped source would confuse which of the two a blocked write was blocked by.
async function buildRelated(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
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
    name: "Folder",
    define: { title: { type: Sequelize.STRING, allowNull: true } },
    options: { timestamps: false, tableName: "folders" },
    relationships: [{
      type: "hasMany",
      model: "Doc",
      name: "docs",
      options: { foreignKey: "folderId" },
    }],
  });
  await db.addDefinition({
    name: "Doc",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      ownerId: { type: Sequelize.INTEGER, allowNull: true },
    },
    options: { timestamps: false, tableName: "docs" },
    relationships: [{
      type: "belongsTo",
      model: "Folder",
      name: "folder",
      options: { foreignKey: "folderId" },
    }],
  });
  await db.initialise();
  await db.sync();
  return db;
}

type Related = Awaited<ReturnType<typeof buildRelated>>;

/** A folder holding one owned and one unowned doc — the pair every verb below sorts. */
async function seedFolder(db: Related, attached: boolean) {
  const folder = await db.models.Folder.create({ title: "f" });
  const folderId = attached ? folder.id : null;
  await db.models.Doc.bulkCreate([
    { name: "mine", ownerId: 1, folderId },
    { name: "theirs", ownerId: 2, folderId },
  ]);
  return folder;
}

/** Which docs the folder currently holds, by name. */
async function docsIn(db: Related, folder: { id: unknown }) {
  const rows = await db.models.Doc.findAll({ where: { folderId: folder.id } });
  return (rows as NamedRow[]).map((r) => r.name).sort();
}

const scopeDoc = (fn: ScopePredicate): ScopePredicate =>
  (defName, operation, options, context) =>
    (defName === "Doc" ? fn(defName, operation, options, context) : undefined);

describe("ormize - row-level scope, nested relationship mutations", () => {
  it("scopes the rows a nested `update` reaches", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // The nested filter is empty — every doc in the folder matches it — so the
    // only thing standing between the caller and someone else's row is the
    // scope merged into `s.where`.
    const names = (await db.models.Doc.findAll({})) as NamedRow[];
    expect(names.map((r) => r.name).sort()).toEqual(["renamed", "theirs"]);
  });

  it("scopes the rows a nested `remove` detaches", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { remove: [{}] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    expect(await docsIn(db, folder)).toEqual(["theirs"]);
  });

  it("scopes the rows a nested `add` attaches (findByFilter)", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    const folder = await seedFolder(db, false);
    await db.processUpdate("Folder", null, {
      input: { docs: { add: [{}] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // `add` reaches its rows through `findByFilter` rather than the association
    // accessor, which is the second of the two seams and is easy to miss.
    expect(await docsIn(db, folder)).toEqual(["mine"]);
  });

  it("scopes the rows a nested `set` replaces the collection with", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    const folder = await seedFolder(db, false);
    await db.processUpdate("Folder", null, {
      input: { docs: { set: [{}] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    expect(await docsIn(db, folder)).toEqual(["mine"]);
  });

  it("still narrows a nested verb by the target's read scope alone", async () => {
    const db = await buildRelated({
      scope: scopeDoc((_d, operation) => (operation === "read" ? { where: { ownerId: { eq: 1 } } } : undefined)),
    });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // Reaching an existing row is a read whatever is done to it next, so a
    // deployment that scopes only reads still cannot write through a nested verb
    // to a row it cannot see.
    const names = (await db.models.Doc.findAll({})) as NamedRow[];
    expect(names.map((r) => r.name).sort()).toEqual(["renamed", "theirs"]);
  });

  it("applies no nested verb at all when the target denies that operation", async () => {
    const db = await buildRelated({
      scope: scopeDoc((_d, operation) => (operation === "update" ? false : undefined)),
    });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // Denied outright: there is no filter that matches nothing, so the verb has
    // to be skipped rather than narrowed.
    expect(await db.models.Doc.count({ where: { name: "renamed" } })).toEqual(0);
  });

  it("applies no nested verb when the target denies reads outright", async () => {
    const db = await buildRelated({
      scope: scopeDoc((_d, operation) => (operation === "read" ? false : undefined)),
    });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // A deny has no filter to narrow with, so a `false` read scope has to skip
    // the verb rather than fall through to the operation's own scope — which
    // here imposes nothing, and would run the write against every row.
    expect(await db.models.Doc.count({ where: { name: "renamed" } })).toEqual(0);
  });

  it("asks the target's scope for the operation each verb performs", async () => {
    const seen: string[] = [];
    const db = await buildRelated({
      scope: scopeDoc((_defName, operation) => {
        seen.push(operation);
        return undefined;
      }),
    });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { delete: [{}] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // `delete` first, then the read that reaching the rows is; the re-entered
    // `processDelete` asks for the same pair and gets the memo. A verb table
    // that scoped everything as an update would show that third entry.
    expect(seen).toEqual(["delete", "read"]);
  });

  it("refuses a denied nested verb loudly when onScopeMiss is 'throw'", async () => {
    const db = await buildRelated({
      scope: scopeDoc((_d, operation) => (operation === "update" ? false : undefined)),
      onScopeMiss: "throw",
    });
    const folder = await seedFolder(db, true);
    await expect(db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1))).rejects.toBeInstanceOf(ScopeDeniedError);
  });

  it("forces `set` on a nested create, through processCreate", async () => {
    const db = await buildRelated({ scope: scopeDoc(() => ({ set: { ownerId: 7 } })) });
    const folder = await seedFolder(db, false);
    await db.processUpdate("Folder", null, {
      input: { docs: { create: [{ name: "fresh" }] } },
      where: { id: { eq: folder.id } },
    }, ctx(7));
    const fresh = await db.models.Doc.findOne({ where: { name: "fresh" } });
    expect((fresh as OwnedRow).ownerId).toEqual(7);
  });

  it("does not force the create scope's `set` on a nested update", async () => {
    const db = await buildRelated({
      scope: scopeDoc((_d, operation) => (operation === "create"
        ? { set: { ownerId: 7 } }
        : { where: { ownerId: { eq: 1 } } })),
    });
    const folder = await seedFolder(db, true);
    await db.processUpdate("Folder", null, {
      input: { docs: { update: [{ where: {}, input: { name: "renamed" } }] } },
      where: { id: { eq: folder.id } },
    }, ctx(1));
    // The nested `update` verb has no single row to hand `processInputs`, so an
    // implementation that reads the absent row as "this must be a create" would
    // hand the caller's own row to someone else.
    const mine = await db.models.Doc.findOne({ where: { name: "renamed" } });
    expect((mine as OwnedRow).ownerId).toEqual(1);
  });
});

/** The eager plan gqlize would build for `folders { docs { … } }`. */
const eagerDocs = () => ({ include: [{ docs: { target: "Doc", associationType: "hasMany" } }] });

describe("ormize - row-level scope, relationship reads (F4)", () => {
  it("scopes an eagerly-included relationship", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, eagerDocs(), ctx(1));
    // Loaded by the *parent's* query, so the relationship's own resolver never
    // sees a filter — the include descriptor is the only place to put one.
    const docs = (models[0] as { docs: NamedRow[] }).docs;
    expect(docs.map((d) => d.name)).toEqual(["mine"]);
  });

  it("keeps a parent none of whose children are in scope", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(99)) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, eagerDocs(), ctx(1));
    // Sequelize reads a `where` on an include as "INNER JOIN" unless told
    // otherwise, so an injected scope would quietly delete the parent row too.
    expect(models).toHaveLength(1);
    expect((models[0] as { docs: NamedRow[] }).docs).toEqual([]);
  });

  it("scopes an include nested below another include", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    await seedFolder(db, true);
    // `docs { folder { docs } }` — the innermost level is two joins from the
    // root, and a plan walked only one level deep hands back the whole folder.
    const { models } = await db.resolveFindAll("Doc", null, {
      include: [{
        folder: {
          target: "Folder",
          associationType: "belongsTo",
          include: [{ docs: { target: "Doc", associationType: "hasMany" } }],
        },
      }],
    }, ctx(1));
    const inner = (models[0] as { folder: { docs: NamedRow[] } }).folder.docs;
    expect(inner.map((d) => d.name)).toEqual(["mine"]);
  });

  it("drops the eager include when the target denies reads outright", async () => {
    const db = await buildRelated({ scope: scopeDoc(() => false) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, eagerDocs(), ctx(1));
    expect(models).toHaveLength(1);
    // Not loaded at all: the relationship falls back to its own resolver, which
    // answers a denied scope with an empty page.
    expect((models[0] as { docs?: NamedRow[] }).docs).toBeUndefined();
  });

  it("scopes a collection reached through its accessor, count included", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    const folder = await seedFolder(db, true);
    const row = await db.models.Folder.findOne({ where: { id: folder.id } });
    const { total, models } = await db.resolveManyRelationship(
      "Doc", db.getAssociations("Folder").docs, row, {}, ctx(1),
    );
    expect((models as NamedRow[]).map((d) => d.name)).toEqual(["mine"]);
    // The count runs off the same args, so a scope applied only to the fetch
    // would leave `total` reporting the row the caller cannot see.
    expect(total).toEqual(1);
  });

  it("returns an empty page for a collection whose target denies reads", async () => {
    const db = await buildRelated({ scope: scopeDoc(() => false) });
    const folder = await seedFolder(db, true);
    const row = await db.models.Folder.findOne({ where: { id: folder.id } });
    const { total, models } = await db.resolveManyRelationship(
      "Doc", db.getAssociations("Folder").docs, row, {}, ctx(1),
    );
    expect(models).toEqual([]);
    expect(total).toEqual(0);
  });

  it("scopes a singular relationship reached through its accessor", async () => {
    const db = await buildRelated({
      scope: (defName) => (defName === "Folder" ? { where: { title: { eq: "elsewhere" } } } : undefined),
    });
    await seedFolder(db, true);
    const doc = await db.models.Doc.findOne({ where: { name: "mine" } });
    // A singular relationship never reads `args.where` — the accessor is handed
    // the options bag and nothing else — so this is a second, separate seam.
    const folder = await db.resolveSingleRelationship(
      "Folder", db.getAssociations("Doc").folder, doc, {}, ctx(1),
    );
    expect(folder).toBeFalsy();
  });

  it("still returns a singular relationship the scope allows", async () => {
    const db = await buildRelated({
      scope: (defName) => (defName === "Folder" ? { where: { title: { eq: "f" } } } : undefined),
    });
    await seedFolder(db, true);
    const doc = await db.models.Doc.findOne({ where: { name: "mine" } });
    const folder = await db.resolveSingleRelationship(
      "Folder", db.getAssociations("Doc").folder, doc, {}, ctx(1),
    );
    expect(folder).toBeTruthy();
  });

  it("returns nothing for a singular relationship whose target denies reads", async () => {
    const db = await buildRelated({
      scope: (defName) => (defName === "Folder" ? false : undefined),
    });
    await seedFolder(db, true);
    const doc = await db.models.Doc.findOne({ where: { name: "mine" } });
    const folder = await db.resolveSingleRelationship(
      "Folder", db.getAssociations("Doc").folder, doc, {}, ctx(1),
    );
    expect(folder).toBeNull();
  });
});

// Two sqlite adapters is all "cross-adapter" means to the engine: the two ends
// have different `OrmAdapter` instances, so there is no association to delegate
// to and ormize resolves the pair itself. `Vault` lives on one, `File` and `Tag`
// on the other, so every relationship below takes the proxy path.
async function buildCross(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission, onScopeMiss: options.onScopeMiss });
  db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite2");
  await db.addDefinition({
    name: "Vault",
    define: { title: { type: Sequelize.STRING, allowNull: true } },
    options: { timestamps: false, tableName: "vaults" },
    relationships: [
      { type: "hasMany", model: "File", name: "files", options: { foreignKey: "vaultId" } },
      { type: "belongsToMany", model: "Tag", name: "tags", options: { foreignKey: "vaultId" } },
    ],
  }, "sqlite");
  await db.addDefinition({
    name: "File",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      ownerId: { type: Sequelize.INTEGER, allowNull: true },
      vaultId: { type: Sequelize.INTEGER, allowNull: true },
    },
    options: { timestamps: false, tableName: "files" },
    relationships: [
      { type: "belongsTo", model: "Vault", name: "vault", options: { foreignKey: "vaultId" } },
    ],
  }, "sqlite2");
  await db.addDefinition({
    name: "Tag",
    define: { label: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false, tableName: "tags" },
  }, "sqlite2");
  await db.initialise();
  await db.sync();
  return db;
}

type Cross = Awaited<ReturnType<typeof buildCross>>;

/** A vault holding one owned and one unowned file, plus one tag linked to it. */
async function seedCross(db: Cross) {
  const vault = await db.models.Vault.create({ title: "v" });
  await db.models.File.bulkCreate([
    { name: "mine", ownerId: 1, vaultId: vault.id },
    { name: "theirs", ownerId: 2, vaultId: vault.id },
  ]);
  const tag = await db.models.Tag.create({ label: "t" });
  return { vault, tag };
}

const scopeModel = (name: string, fn: ScopePredicate): ScopePredicate =>
  (defName, operation, options, context) =>
    (defName === name ? fn(defName, operation, options, context) : undefined);

const named = (rows: unknown) => (rows as NamedRow[]).map((r) => r.name).sort();

describe("ormize - row-level scope, cross-adapter proxies (F5)", () => {
  it("scopes the collection proxy accessor", async () => {
    const db = await buildCross({ scope: scopeModel("File", ownedBy(1)) });
    const { vault } = await seedCross(db);
    // `getFiles` runs the *target's* `findAll` directly, on the target's own
    // adapter. Nothing upstream has scoped it, and any code holding a vault row
    // can call it.
    expect(named(await vault.getFiles(ctx(1)))).toEqual(["mine"]);
  });

  it("returns nothing from the collection proxy when the target denies reads", async () => {
    const db = await buildCross({ scope: scopeModel("File", () => false) });
    const { vault } = await seedCross(db);
    expect(await vault.getFiles(ctx(1))).toEqual([]);
  });

  it("scopes the singular proxy accessor", async () => {
    const db = await buildCross({
      scope: scopeModel("Vault", () => ({ where: { title: { eq: "elsewhere" } } })),
    });
    await seedCross(db);
    const file = await db.models.File.findOne({ where: { name: "mine" } });
    expect(await file.getVault(ctx(1))).toBeFalsy();
  });

  it("returns nothing from the singular proxy when the target denies reads", async () => {
    const db = await buildCross({ scope: scopeModel("Vault", () => false) });
    await seedCross(db);
    const file = await db.models.File.findOne({ where: { name: "mine" } });
    expect(await file.getVault(ctx(1))).toBeNull();
  });

  it("scopes the engine's cross-adapter relationship read", async () => {
    const db = await buildCross({ scope: scopeModel("File", ownedBy(1)) });
    const { vault } = await seedCross(db);
    const { total, models } = await db.resolveManyRelationship(
      "File", db.getAssociations("Vault").files, vault, {}, ctx(1),
    );
    expect(named(models)).toEqual(["mine"]);
    expect(total).toEqual(1);
  });

  it("scopes the belongs-to-many through-model read", async () => {
    const db = await buildCross({
      // Reads only: a scope that denied every operation would refuse the link
      // below as well, and the test would pass without the read ever being
      // scoped at all.
      scope: scopeModel("TagVault", (_d, operation) => (operation === "read" ? false : undefined)),
    });
    const { vault, tag } = await seedCross(db);
    await vault.addTag(tag);
    // The join row exists and the target is unscoped, but the *edge* is not
    // this principal's to see — and an unscoped join read leaks the link even
    // when both ends of it are scoped out.
    expect(await vault.getTags(ctx(1))).toEqual([]);
  });

  it("scopes the belongs-to-many target read", async () => {
    const db = await buildCross({
      scope: scopeModel("Tag", () => ({ where: { label: { eq: "other" } } })),
    });
    const { vault, tag } = await seedCross(db);
    await vault.addTag(tag);
    expect(await vault.getTags(ctx(1))).toEqual([]);
  });

  it("refuses a proxy write to a row the scope denies outright", async () => {
    const db = await buildCross({
      scope: scopeModel("File", (_d, operation) => (operation === "update" ? false : undefined)),
    });
    const { vault } = await seedCross(db);
    const loose = await db.models.File.create({ name: "loose", ownerId: 2, vaultId: null });
    await vault.addFile(loose, ctx(1));
    const after = await db.models.File.findOne({ where: { name: "loose" } });
    expect(after.vaultId).toBeNull();
  });

  it("refuses a proxy write to a row outside a filter-shaped scope", async () => {
    const db = await buildCross({ scope: scopeModel("File", ownedBy(1)) });
    const { vault } = await seedCross(db);
    const mine = await db.models.File.create({ name: "loose-mine", ownerId: 1, vaultId: null });
    const theirs = await db.models.File.create({ name: "loose-theirs", ownerId: 2, vaultId: null });
    // An instance write has no filter to narrow, so the scope is checked and the
    // write refused — per row, so one refused member of a batch does not take
    // the rest of the batch with it.
    await vault.addFiles([mine, theirs], ctx(1));
    const rows = await db.models.File.findAll({ where: { vaultId: vault.id } });
    expect(named(rows)).toEqual(["loose-mine", "mine", "theirs"]);
  });

  it("throws on a refused proxy write under onScopeMiss: throw", async () => {
    const db = await buildCross({
      scope: scopeModel("File", (_d, operation) => (operation === "update" ? false : undefined)),
      onScopeMiss: "throw",
    });
    const { vault } = await seedCross(db);
    const loose = await db.models.File.create({ name: "loose", ownerId: 2, vaultId: null });
    await expect(vault.addFile(loose, ctx(1))).rejects.toThrow(/scope/i);
  });

  it("refuses a belongs-to proxy write, which writes the source row", async () => {
    const db = await buildCross({
      scope: scopeModel("File", (_d, operation) => (operation === "update" ? false : undefined)),
    });
    const { vault } = await seedCross(db);
    const loose = await db.models.File.create({ name: "loose", ownerId: 2, vaultId: null });
    // `setVault` points a key that lives on the *file*, so it is the file's
    // update scope that decides — not the vault's.
    await loose.setVault(vault, ctx(1));
    const after = await db.models.File.findOne({ where: { name: "loose" } });
    expect(after.vaultId).toBeNull();
  });

  it("scopes the join rows a belongs-to-many unlink deletes", async () => {
    const db = await buildCross({
      scope: scopeModel("TagVault", (_d, operation) => (operation === "delete" ? false : undefined)),
    });
    const { vault, tag } = await seedCross(db);
    await vault.addTag(tag);
    await vault.removeTag(tag, ctx(1));
    // Unlinking deletes by filter, so the scope merges in rather than being
    // checked — and a denied one leaves the edge where it was.
    expect(await vault.getTags(ctx(1))).toHaveLength(1);
  });

  it("refuses to create a join row the through model's scope denies", async () => {
    const db = await buildCross({
      scope: scopeModel("TagVault", (_d, operation) => (operation === "create" ? false : undefined)),
    });
    const { vault, tag } = await seedCross(db);
    await vault.addTag(tag, ctx(1));
    expect(await vault.getTags(ctx(1))).toEqual([]);
  });
});

describe("ormize - row-level scope, the read half of a root write", () => {
  // A deployment that scopes only reads is the common starting point: "these are
  // your rows" is one sentence, and the write scopes are usually the same
  // sentence again. Reaching a row is a read whatever happens to it next, so the
  // read scope has to bound the write filters too.
  const readable = (id: number): ScopePredicate =>
    (_defName, operation) => (operation === "read" ? { where: { ownerId: { eq: id } } } : undefined);

  it("narrows a root update by the read scope alone", async () => {
    const db = await buildOrm({ scope: readable(1) });
    await seed(db);
    await db.processUpdate("Doc", null, { input: { name: "renamed" }, where: {} }, ctx(1));
    const names = (await db.models.Doc.findAll({})) as NamedRow[];
    expect(names.map((r) => r.name).sort()).toEqual(["renamed", "renamed", "theirs"]);
  });

  it("narrows a root delete by the read scope alone", async () => {
    const db = await buildOrm({ scope: readable(1) });
    await seed(db);
    await db.processDelete("Doc", null, {}, ctx(1));
    const names = (await db.models.Doc.findAll({})) as NamedRow[];
    expect(names.map((r) => r.name)).toEqual(["theirs"]);
  });

  it("narrows a root select by the read scope alone", async () => {
    const db = await buildOrm({ scope: readable(1) });
    await seed(db);
    const results = await db.processSelect("Doc", null, { input: {}, where: {} }, ctx(1));
    expect(results).toHaveLength(2);
  });

  it("refuses a root write outright when reads are denied", async () => {
    const db = await buildOrm({ scope: (_d, operation) => (operation === "read" ? false : undefined) });
    await seed(db);
    // A deny has no filter to narrow with, so the write is skipped rather than
    // falling through to the update scope — which imposes nothing here, and
    // would run against every row in the table.
    expect(await db.processUpdate("Doc", null, { input: { name: "x" }, where: {} }, ctx(1))).toEqual([]);
    expect(await db.models.Doc.count({ where: { name: "x" } })).toEqual(0);
  });
});

describe("ormize - row-level scope, writes that move a row out (F6)", () => {
  // A `where` and no `set` is the ordinary shape of a scope: it says which rows
  // are yours, not what a new one has to contain. Nothing in `processInputs` can
  // hold a row inside a scope shaped like that, so the only way to know the
  // write did not carry it out is to look afterwards.
  const owned = (id: number): ScopePredicate => () => ({ where: { ownerId: { eq: id } } });

  // "Your docs are the ones in *this* folder" — a scope over the very key the
  // link verbs re-point. The folder cannot exist before the orm does, so the
  // predicate reads it out of a holder rather than closing over a value.
  const scopeDocsToFolder = () => {
    const home: { id?: unknown } = {};
    return { home, scope: scopeDoc(() => ({ where: { folderId: { eq: home.id } } })) };
  };

  it("refuses an update that carries the row out of the scope", async () => {
    const db = await buildOrm({ scope: owned(1) });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    await expect(
      db.processUpdate("Doc", null, { input: { ownerId: 2 }, where: { id: { eq: mine.id } } }, ctx(1)),
    ).rejects.toBeInstanceOf(ScopeEscapeError);
    // `mutationEntry` runs the whole mutation in a transaction, so the refusal
    // takes the write with it rather than leaving it half applied.
    await mine.reload();
    expect(mine.ownerId).toEqual(1);
  });

  it("throws whatever onScopeMiss says, because the row was already written", async () => {
    const db = await buildOrm({ scope: owned(1), onScopeMiss: "empty" });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    // The quiet path exists so a refused write is indistinguishable from one
    // that matched no rows. That equivalence is gone once the write happened.
    await expect(
      db.processUpdate("Doc", null, { input: { ownerId: 2 }, where: { id: { eq: mine.id } } }, ctx(1)),
    ).rejects.toBeInstanceOf(ScopeEscapeError);
  });

  it("leaves an update that stays inside the scope alone", async () => {
    const db = await buildOrm({ scope: owned(1) });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    const results = await db.processUpdate(
      "Doc", null, { input: { name: "renamed" }, where: { id: { eq: mine.id } } }, ctx(1),
    );
    expect(results).toHaveLength(1);
    await mine.reload();
    expect(mine.name).toEqual("renamed");
  });

  it("refuses a create that lands outside the scope", async () => {
    const db = await buildOrm({ scope: owned(1) });
    await expect(
      db.processCreate("Doc", null, { input: { name: "fresh", ownerId: 2 } }, ctx(1)),
    ).rejects.toBeInstanceOf(ScopeEscapeError);
    expect(await db.models.Doc.count()).toEqual(0);
  });

  it("creates a row that lands inside the scope", async () => {
    const db = await buildOrm({ scope: owned(1) });
    const [row] = await db.processCreate(
      "Doc", null, { input: { name: "fresh", ownerId: 1 } }, ctx(1),
    ) as OwnedRow[];
    expect(row.ownerId).toEqual(1);
  });

  it("refuses a nested `add` that re-points the target's foreign key out of the scope", async () => {
    const { home, scope } = scopeDocsToFolder();
    const db = await buildRelated({ scope });
    const f1 = await seedFolder(db, true);
    const f2 = await db.models.Folder.create({ title: "f2" });
    home.id = f1.id;
    // `add` writes no column the caller named — it re-points a foreign key — so
    // a scope's `set` has nothing to hold in place and the verb's own filter has
    // already done its job by the time the row moves.
    await expect(db.processUpdate("Folder", null, {
      input: { docs: { add: [{}] } },
      where: { id: { eq: f2.id } },
    }, ctx(1))).rejects.toBeInstanceOf(ScopeEscapeError);
    expect(await docsIn(db, f2)).toEqual([]);
  });

  it("refuses a nested collection `set` that re-points a foreign key out of the scope", async () => {
    const { home, scope } = scopeDocsToFolder();
    const db = await buildRelated({ scope });
    const f1 = await seedFolder(db, true);
    const f2 = await db.models.Folder.create({ title: "f2" });
    home.id = f1.id;
    // `set` is `add`'s other half — same accessor, same moved key — and lives in
    // its own branch of its own verb, so it gets its own row here.
    await expect(db.processUpdate("Folder", null, {
      input: { docs: { set: [{}] } },
      where: { id: { eq: f2.id } },
    }, ctx(1))).rejects.toBeInstanceOf(ScopeEscapeError);
    expect(await docsIn(db, f2)).toEqual([]);
  });

  it("refuses a nested `set` that re-points the source row's own foreign key", async () => {
    const { home, scope } = scopeDocsToFolder();
    const db = await buildRelated({ scope });
    const f1 = await seedFolder(db, true);
    const f2 = await db.models.Folder.create({ title: "f2" });
    home.id = f1.id;
    // A `belongsTo` `set` writes the key on the *source*, so that is the end the
    // check has to look at. Reached through `select`, which applies the verb
    // without a root post-write check of its own to catch it first.
    await expect(db.processSelect("Doc", null, {
      input: { folder: { set: { id: { eq: f2.id } } } },
      where: { name: { eq: "mine" } },
    }, ctx(1))).rejects.toBeInstanceOf(ScopeEscapeError);
    expect(await docsIn(db, f1)).toEqual(["mine", "theirs"]);
  });
});

describe("ormize - row-level scope, the adapter hooks (\u00a713)", () => {
  // Decision 8, belt and braces. Everything above this point merges the scope
  // into a query the *engine* is building. These tests reach the model the way
  // the surfaces \u00a712 is about reach it \u2014 a class method, an extend field, a
  // row someone is holding \u2014 where there is no engine chokepoint in the path at
  // all, and the only thing left between the caller and the table is the
  // adapter's own hooks.
  //
  // `getGraphQLArgs` is what makes such a call answerable: it is the channel the
  // guide already documents for `beforeFind`, and it carries the request a
  // predicate needs. A query without one is a query with no principal to ask
  // about, and is deliberately left alone \u2014 see the test that pins it.
  const asRequest = (id: number) => ({
    getGraphQLArgs: () => ({ context: ctx(id), info: undefined, source: undefined }),
  });

  it("scopes a query issued straight off the model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const rows = await db.models.Doc.findAll(asRequest(1)) as NamedRow[];
    expect(rows.map((r) => r.name).sort()).toEqual(["mine-1", "mine-2"]);
  });

  it("scopes a count issued straight off the model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    // `count` does not go through `findAll`, so `beforeFind` never fires for it.
    // Its own hook is why the number and the rows agree.
    expect(await db.models.Doc.count(asRequest(1))).toEqual(2);
  });

  it("returns nothing \u2014 not everything \u2014 when the scope denies a query outright", async () => {
    const db = await buildOrm({ scope: () => false });
    await seed(db);
    // The hook is handed a query that is already going to run: cancelling it is
    // not on offer, so the denial has to be said in the filter's own vocabulary.
    expect(await db.models.Doc.findAll(asRequest(1))).toEqual([]);
  });

  it("stands aside for a query that carries no request", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    // Holding the model directly is a documented feature, used throughout this
    // repo's own fixtures, and there is no principal in such a call to ask a
    // predicate about. \u00a712 covers this surface by refusing to *build* a scoped
    // model that userland can reach unscoped \u2014 not by failing every call here.
    expect(await db.models.Doc.count({})).toEqual(3);
  });

  it("scopes a bulk update issued straight off the model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    await db.models.Doc.update({ name: "renamed" }, { where: {}, ...asRequest(1) });
    const rows = await db.models.Doc.findAll({}) as NamedRow[];
    expect(rows.map((r) => r.name).sort()).toEqual(["renamed", "renamed", "theirs"]);
  });

  it("scopes a bulk destroy issued straight off the model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    await db.models.Doc.destroy({ where: {}, ...asRequest(1) });
    const rows = await db.models.Doc.findAll({}) as NamedRow[];
    expect(rows.map((r) => r.name)).toEqual(["theirs"]);
  });

  it("refuses an instance update the principal may not write", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const theirs = await db.models.Doc.findOne({ where: { name: "theirs" } });
    // An instance write has no filter to narrow and no empty page to hand back:
    // `save()` either happens or it does not. So this refuses loudly whatever
    // `onScopeMiss` says \u2014 the quiet alternative is not silence, it is letting
    // the write through.
    await expect(theirs.update({ name: "taken" }, asRequest(1)))
      .rejects.toBeInstanceOf(ScopeDeniedError);
    await theirs.reload();
    expect(theirs.name).toEqual("theirs");
  });

  it("refuses an instance destroy the principal may not write", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const theirs = await db.models.Doc.findOne({ where: { name: "theirs" } });
    await expect(theirs.destroy(asRequest(1))).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(await db.models.Doc.count({})).toEqual(3);
  });

  it("leaves an instance write the principal may make alone", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const mine = await db.models.Doc.findOne({ where: { name: "mine-1" } });
    await mine.update({ name: "renamed" }, asRequest(1));
    await mine.reload();
    expect(mine.name).toEqual("renamed");
  });

  it("forces a create's `set` on a row inserted straight off the model", async () => {
    const db = await buildOrm({ scope: () => ({ where: { ownerId: { eq: 1 } }, set: { ownerId: 1 } }) });
    const row = await db.models.Doc.create({ name: "fresh" }, asRequest(1)) as OwnedRow;
    expect(row.ownerId).toEqual(1);
  });

  it("refuses a create whose value disagrees with the scope's `set`", async () => {
    const db = await buildOrm({ scope: () => ({ where: { ownerId: { eq: 1 } }, set: { ownerId: 1 } }) });
    // Writing the safe value anyway is the tempting implementation, and it turns
    // a forged request into a successful mutation nothing downstream can see.
    await expect(db.models.Doc.create({ name: "forged", ownerId: 2 }, asRequest(1)))
      .rejects.toBeInstanceOf(ScopeDeniedError);
    expect(await db.models.Doc.count({})).toEqual(0);
  });

  it("refuses a create outright when the scope denies", async () => {
    const db = await buildOrm({ scope: () => false });
    await expect(db.models.Doc.create({ name: "fresh" }, asRequest(1)))
      .rejects.toBeInstanceOf(ScopeDeniedError);
    expect(await db.models.Doc.count({})).toEqual(0);
  });

  it("scopes an eagerly-included relationship (F4)", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    await seedFolder(db, true);
    const [folder] = await db.models.Folder.findAll({
      include: [{ model: db.models.Doc, as: "docs" }],
      ...asRequest(1),
    }) as { docs: NamedRow[] }[];
    // A child loaded by its parent's query has no resolver of its own and no
    // filter of its own to merge into. The include descriptor is the only place
    // a scope can reach it.
    expect(folder.docs.map((d) => d.name)).toEqual(["mine"]);
  });

  it("does not let a scoped include become a filter on its parent", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(3)) });
    await seedFolder(db, true);
    const folders = await db.models.Folder.findAll({
      include: [{ model: db.models.Doc, as: "docs" }],
      ...asRequest(3),
    }) as { docs: NamedRow[] }[];
    // Decision 6. Sequelize infers requiredness from the presence of a `where`,
    // so an injected filter left unmarked turns the LEFT JOIN into an INNER one
    // and the parent disappears along with its children.
    expect(folders).toHaveLength(1);
    expect(folders[0].docs).toEqual([]);
  });

  it("cannot be displaced by a definition hook that rewrites `where`", async () => {
    const db = await buildOrm({
      scope: ownedBy(1),
      hooks: {
        beforeFind: (options: { where?: unknown }) => {
          // The hook owns `where` and overwrites whatever was there \u2014 exactly
          // what a deployment that did row filtering the old way looks like.
          options.where = {};
          return options;
        },
      },
    });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect((models as NamedRow[]).map((m) => m.name).sort()).toEqual(["mine-1", "mine-2"]);
    expect(total).toEqual(2);
  });

  it("cannot be displaced by a global hook either", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    // Global hooks run after definition hooks, so "last registered wins" would
    // put this one on top. The enforcement is not registered here at all: it
    // lives in a map nothing can push onto, which is what makes "last" a
    // property of the code rather than of the order someone called `addHook` in.
    db.addHook("beforeFind", (_defName: string, options: { where?: unknown }) => {
      options.where = {};
      return options;
    });
    await seed(db);
    const { total } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect(total).toEqual(2);
  });

  it("resolves a scope whose predicate runs a query of its own", async () => {
    const orm: { db?: Orm } = {};
    let calls = 0;
    let seenByPredicate = -1;
    const scope: ScopePredicate = async(defName, operation, _options, context) => {
      if (defName !== "Doc" || operation !== "read" || !orm.db) {
        return undefined;
      }
      calls += 1;
      // The shape every real membership lookup takes: the predicate asks a
      // question, and answering it fires the very hook that is waiting on this
      // predicate. The memo holds the *promise*, so an unguarded re-entry would
      // await the promise it is itself producing and never return.
      const { models } = await orm.db.resolveFindAll("Doc", null, {}, context);
      seenByPredicate = (models as unknown[]).length;
      return { where: { ownerId: { eq: 1 } } };
    };
    orm.db = await buildOrm({ scope });
    await seed(orm.db);
    const { total } = await orm.db.resolveFindAll("Doc", null, {}, ctx(1));
    expect(calls).toEqual(1);
    // Unscoped, and necessarily so: a query a predicate issues cannot be asked
    // to satisfy the scope that predicate is in the middle of deciding.
    expect(seenByPredicate).toEqual(3);
    expect(total).toEqual(2);
  });
});
