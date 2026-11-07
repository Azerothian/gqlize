// Row-level scope tests: the read half of a root write, writes that move a row
// out (F6), the adapter hooks (section 13), the surfaces the engine cannot reach
// (section 12), raw SQL (section 12), raw SQL class methods (section 12), and the
// instance-level backstop (section 12).
// Split from scope.test.ts for readability.

import { describe, it, expect, jest } from "@jest/globals";
import type { ScopePredicate, ResolvedScope } from "@azerothian/utilize/gate";
import { scopeAware, unscoped } from "@azerothian/utilize/gate";
import { ScopeDeniedError, ScopeEscapeError } from "../src/scope";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import {
  buildOrm, seed, ownedBy, ctx,
  buildRelated, seedFolder, docsIn, scopeDoc,
  type Orm, type NamedRow, type OwnedRow,
} from "./helper/scope-fixtures";

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

describe("ormize - row-level scope, the adapter hooks (§13)", () => {
  // Decision 8, belt and braces. Everything above this point merges the scope
  // into a query the *engine* is building. These tests reach the model the way
  // the surfaces §12 is about reach it — a class method, an extend field, a
  // row someone is holding — where there is no engine chokepoint in the path at
  // all, and the only thing left between the caller and the table is the
  // adapter's own hooks.
  //
  // `getGraphQLArgs` is what makes such a call answerable: it is the channel the
  // guide already documents for `beforeFind`, and it carries the request a
  // predicate needs. A query without one is a query with no principal to ask
  // about, and is deliberately left alone — see the test that pins it.
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

  it("returns nothing — not everything — when the scope denies a query outright", async () => {
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
    // predicate about. §12 covers this surface by refusing to *build* a scoped
    // model that userland can reach unscoped — not by failing every call here.
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
    // `onScopeMiss` says — the quiet alternative is not silence, it is letting
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

  it("scopes an include entry that arrived without a target (§13 backstop)", async () => {
    // A client-supplied `include:` names a relation but carries no `target` —
    // the generated include input type has no such field, and only the
    // selection-derived plan fills one in. So §12's `scopeIncludePlan` asks
    // `readScopeFor(undefined)`, which reaches the deployment's predicate with
    // no model name and comes back with nothing to impose.
    //
    // This is the case §13 exists for. The adapter hook scopes native includes
    // off the *model* on each entry rather than the portable descriptor, so the
    // join is still filtered. Asserting `LOADED` as well as the rows is the
    // whole point: without it this would pass just as happily if the relation
    // had never been joined at all.
    const db = await buildRelated({ scope: scopeDoc(ownedBy(3)) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, {
      include: [{ docs: { associationType: "hasMany" } }],
    }, ctx(3));
    const folder = models[0] as unknown as { docs?: NamedRow[] };
    expect(folder.docs).toBeDefined();
    expect(folder.docs).toEqual([]);
  });

  it("honours `required: true` on a scoped include through the engine's include plan (#70)", async () => {
    // The §12 twin of the test below. A caller's `required: true` keeps its
    // INNER JOIN, with the scope inside it: the folder holds docs, but none the
    // caller may see, so it has no visible matching child and is excluded —
    // the same answer as if those docs did not exist at all.
    const db = await buildRelated({ scope: scopeDoc(ownedBy(3)) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, {
      include: [{ docs: { target: "Doc", associationType: "hasMany", required: true } }],
    }, ctx(3));
    expect(models).toHaveLength(0);
  });

  it("honours `required: true` on a scoped native include (#70)", async () => {
    // Forcing `required: false` here turned every scoped `required` into a
    // LEFT JOIN, so parents the caller asked to exclude came back anyway.
    const db = await buildRelated({ scope: scopeDoc(ownedBy(3)) });
    await seedFolder(db, true);
    const folders = await db.models.Folder.findAll({
      include: [{ model: db.models.Doc, as: "docs", required: true }],
      ...asRequest(3),
    }) as { docs: NamedRow[] }[];
    expect(folders).toHaveLength(0);
  });

  it("keeps a `required: true` parent whose matching child is visible, with only the visible children", async () => {
    const db = await buildRelated({ scope: scopeDoc(ownedBy(1)) });
    await seedFolder(db, true);
    await db.models.Folder.create({ title: "empty" });
    const { models } = await db.resolveFindAll("Folder", null, {
      include: [{ docs: { target: "Doc", associationType: "hasMany", required: true } }],
    }, ctx(1));
    const folders = models as unknown as { title: string; docs: NamedRow[] }[];
    expect(folders.map((f) => f.title)).toEqual(["f"]);
    expect(folders[0].docs.map((d) => d.name)).toEqual(["mine"]);
  });

  it("excludes the parent of a `required` include whose model is denied outright", async () => {
    // Dropping the include — what a denied scope does otherwise — would widen
    // the parent list to rows the caller asked to exclude.
    const db = await buildRelated({ scope: scopeDoc(() => false) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, {
      include: [{ docs: { target: "Doc", associationType: "hasMany", required: true } }],
    }, ctx(1));
    expect(models).toHaveLength(0);
  });

  it("still keeps the parent of an unrequired include whose model is denied outright", async () => {
    const db = await buildRelated({ scope: scopeDoc(() => false) });
    await seedFolder(db, true);
    const { models } = await db.resolveFindAll("Folder", null, {
      include: [{ docs: { target: "Doc", associationType: "hasMany", required: false } }],
    }, ctx(1));
    expect(models).toHaveLength(1);
  });

  it("cannot be displaced by a definition hook that rewrites `where`", async () => {
    const db = await buildOrm({
      scope: ownedBy(1),
      hooks: {
        beforeFind: (options: { where?: unknown }) => {
          // The hook owns `where` and overwrites whatever was there — exactly
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

describe("ormize - row-level scope, the surfaces the engine cannot reach (§12)", () => {
  // A class method, an instance method or a raw query runs userland code holding
  // the model directly: no query for the engine to own, and — on an adapter with
  // no hook layer — nothing underneath that knows a request is happening. The
  // scope does not apply there. These pin that the build says so.
  const warned = () => jest.spyOn(console, "warn").mockImplementation(() => {});

  it("says nothing at all when no scope is configured", async () => {
    const warn = warned();
    await buildOrm({ classMethods: { tally: () => 1 } });
    // The audit is about a scope that exists and cannot reach somewhere. With no
    // scope configured there is nothing to fail to apply, and a build that
    // scolded every class method in the repo would be ignored within a week.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns about an unannotated class method on an adapter that enforces below the engine", async () => {
    const warn = warned();
    await buildOrm({ scope: ownedBy(1), classMethods: { tally: () => 1 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Doc.tally (class method)");
    warn.mockRestore();
  });

  it("warns about an unannotated instance method too", async () => {
    const warn = warned();
    await buildOrm({ scope: ownedBy(1), instanceMethods: { describe: () => "x" } });
    expect(String(warn.mock.calls[0][0])).toContain("Doc.describe (instance method)");
    warn.mockRestore();
  });

  it("is silent about a method that admits it runs unscoped", async () => {
    const warn = warned();
    await buildOrm({ scope: ownedBy(1), classMethods: { tally: unscoped(() => 1) } });
    // An admission, not a suppression: it is one line, it lands in the diff next
    // to the code it excuses, and `grep unscoped` finds every one of them.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is silent about a method that claims it applies the scope itself", async () => {
    const warn = warned();
    await buildOrm({ scope: ownedBy(1), classMethods: { tally: scopeAware(() => 1) } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses to build a method that claims both at once", async () => {
    const warn = warned();
    const both = unscoped(scopeAware(() => 1));
    await expect(buildOrm({ scope: ownedBy(1), classMethods: { tally: both } }))
      .rejects.toThrow(/marked both scopeAware and unscoped/);
    warn.mockRestore();
  });

  it("audits a permission bag that arrives after the build", async () => {
    const warn = warned();
    const db = await buildOrm({ classMethods: { tally: () => 1 } });
    expect(warn).not.toHaveBeenCalled();
    db.setPermission({ scope: ownedBy(1) });
    // Hosts that compile permissions from a config file or a Nest module build
    // the bag after the orm exists. Auditing only in `initialise()` would make
    // the check depend on the order a host happened to assemble its options in.
    expect(String(warn.mock.calls[0][0])).toContain("Doc.tally (class method)");
    warn.mockRestore();
  });

  it("hands a scope-aware method the resolved scope", async () => {
    let seen: ResolvedScope | "never asked" = "never asked";
    const db = await buildOrm({
      scope: ownedBy(1),
      classMethods: {
        tally: scopeAware(async(_args: unknown, context: { scopeFor(m: string, o: string): Promise<ResolvedScope> }) => {
          seen = await context.scopeFor("Doc", "read");
          return 1;
        }),
      },
    });
    await db.resolveClassMethod("Doc", "tally", {}, ctx(1));
    // The engine cannot verify the method applied it — that is exactly why the
    // claim has to be explicit. What it can do is make sure the filter is there
    // to apply, from the same memo every other call site reads.
    expect(seen).toEqual({ where: { ownerId: { eq: 1 } } });
  });

  it("does not put `scopeFor` anywhere a serialiser or a spread would find it", async () => {
    const db = await buildOrm({ scope: ownedBy(1), classMethods: { tally: scopeAware(() => 1) } });
    const context = ctx(1) as { scopeFor?: unknown };
    await db.resolveClassMethod("Doc", "tally", {}, context);
    expect(typeof context.scopeFor).toEqual("function");
    // The context belongs to the host. An enumerable key would reach anything
    // that logs it, spreads it into a job payload, or sends it over a wire.
    expect(Object.keys(context)).toEqual(["user"]);
    expect(JSON.parse(JSON.stringify(context))).toEqual({ user: { id: 1 } });
  });

  it("does not overwrite a `scopeFor` the host put there itself", async () => {
    const db = await buildOrm({ scope: ownedBy(1), classMethods: { tally: scopeAware(() => 1) } });
    const own = () => Promise.resolve(undefined);
    const context = Object.assign(ctx(1), { scopeFor: own });
    await db.resolveClassMethod("Doc", "tally", {}, context);
    expect(context.scopeFor).toBe(own);
  });
});

describe("ormize - row-level scope, raw SQL (§12)", () => {
  // The sharpest case, because a SQL descriptor is not code the engine can hand
  // anything to. A named parameter is the only lever it has, so the presence of
  // one *is* the opt-in and the build can check for it in the text.
  const warned = () => jest.spyOn(console, "warn").mockImplementation(() => {});
  const sql = (query: string) => ({ type: "query", query, args: ["id"] });

  it("warns about a raw query that never mentions the scope", async () => {
    const warn = warned();
    await buildOrm({ scope: ownedBy(1), classMethods: { recent: sql("SELECT * FROM docs") } });
    expect(String(warn.mock.calls[0][0])).toContain("Doc.recent (raw-SQL class method)");
    warn.mockRestore();
  });

  it("is silent about one that binds the scope as a named parameter", async () => {
    const warn = warned();
    await buildOrm({
      scope: ownedBy(1),
      classMethods: { recent: sql("SELECT * FROM docs WHERE ownerId = :scopeOwnerId") },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads the generated function form's argument list as its text", async () => {
    const warn = warned();
    await buildOrm({
      scope: ownedBy(1),
      classMethods: { recent: { type: "sqlfunction", functionName: "recent_docs", args: ["scopeOwnerId"] } },
    });
    // `generateSQLFunction` builds `SELECT * FROM fn(:a,:b)` from the argument
    // list when no query text is authored, so there the list *is* the text.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses to build a raw query whose text contradicts its own scopeAware claim", async () => {
    const warn = warned();
    await expect(buildOrm({
      scope: ownedBy(1),
      classMethods: { recent: Object.assign(sql("SELECT * FROM docs"), { scopeAware: true }) },
    })).rejects.toThrow(/never references a ':scope/);
    // Not a judgement about how deeply the backend enforces — the claim and the
    // query are three lines apart and disagree, which is wrong on every adapter.
    warn.mockRestore();
  });

  it("is silent about a raw query that admits it runs unscoped", async () => {
    const warn = warned();
    await buildOrm({
      scope: ownedBy(1),
      classMethods: { recent: Object.assign(sql("SELECT * FROM docs"), { unscoped: true }) },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ormize - row-level scope through a raw SQL class method (§12)", () => {
  // The end of the road for a scope: by the time a statement reaches the driver
  // it is text, so there is nothing left to rewrite. A reserved named parameter
  // is the only lever, which is why §12's audit refuses to build a scoped model
  // whose raw query does not pull it.
  // Quote `"ownerId"` so PostgreSQL's identifier folding does not lowercase it.
  const OWNED = 'SELECT name FROM docs WHERE (:scopeOwnerId IS NULL OR "ownerId" = :scopeOwnerId) ORDER BY name';
  const owned = (args: string[] = []) => ({ type: "query", query: OWNED, args });
  const call = (db: Orm, args: unknown = {}, context: unknown = ctx(1)) =>
    db.resolveClassMethod("Doc", "owned", args, context) as Promise<NamedRow[]>;

  it("binds the value the scope pins the field to", async () => {
    const db = await buildOrm({ scope: ownedBy(1), classMethods: { owned: owned() } });
    await seed(db);
    expect((await call(db)).map((r) => r.name)).toEqual(["mine-1", "mine-2"]);
  });

  it("binds null, and returns everything, when no scope is configured", async () => {
    const db = await buildOrm({ classMethods: { owned: owned() } });
    await seed(db);
    // The permissive half of the idiom doing its job. Its absence is the failure
    // mode worth having: `ownerId = NULL` matches nothing, so an author who
    // writes only the comparison gets an empty page, not the whole table.
    expect((await call(db)).map((r) => r.name)).toEqual(["mine-1", "mine-2", "theirs"]);
  });

  it("returns an empty page when the scope denies outright", async () => {
    const db = await buildOrm({ scope: () => false, classMethods: { owned: owned() } });
    await seed(db);
    expect(await call(db)).toEqual([]);
  });

  it("will not let the caller supply the value that decides what it may read", async () => {
    // `args` is caller-vocabulary and reaches the statement as replacements, so
    // a method declaring `scopeOwnerId` among them hands a request the pen. The
    // binding is applied after that reduction for exactly this reason.
    const db = await buildOrm({ scope: ownedBy(1), classMethods: { owned: owned(["scopeOwnerId"]) } });
    await seed(db);
    expect((await call(db, { scopeOwnerId: 2 })).map((r) => r.name)).toEqual(["mine-1", "mine-2"]);
  });

  it("binds null for a static reached without going through the engine", async () => {
    const db = await buildOrm({ scope: ownedBy(1), classMethods: { owned: owned() } });
    await seed(db);
    // `scopeFor` rides on the request context, so a static called straight off
    // the model has none and this layer cannot tell "unscoped deployment" from
    // "engine bypassed". It binds null and leaves the refusal to the layer that
    // can tell them apart — the instance-level `beforeQuery`.
    const rows = await (db.models.Doc as { owned(a: unknown, c: unknown): Promise<NamedRow[]> })
      .owned({}, undefined);
    expect(rows.map((r) => r.name)).toEqual(["mine-1", "mine-2", "theirs"]);
  });

  it("raises a configuration error for a scope the parameters cannot carry", async () => {
    const db = await buildOrm({
      scope: () => ({ where: { ownerId: { in: [1, 2] } } }),
      classMethods: { owned: owned() },
    });
    await seed(db);
    // Not an empty page: a query enforcing *part* of a scope hands back rows
    // that look filtered, and nothing downstream can tell that they are not.
    await expect(call(db)).rejects.toThrow(ScopeConfigurationError);
  });
});

describe("ormize - row-level scope, the instance-level backstop (§12)", () => {
  // `beforeQuery` fires once per statement, after the SQL is built — so it
  // refuses rather than rewrites. What it catches is the one thing the model
  // hooks cannot see: a statement that reached the driver bound to a model
  // without passing any of them, which in practice is a hand-written
  // `sequelize.query(sql, {model})`.
  const sequelizeOf = (db: Orm) =>
    (db.adapters.sqlite as unknown as { sequelize: {
      query(sql: string, options?: unknown): Promise<unknown>;
    } }).sequelize;

  it("refuses a hand-written query bound to a scoped model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    // The documented escape hatch, and a complete bypass: no `where` to narrow,
    // no hook in the path, and the rows come back mapped onto the model as
    // though the orm had produced them.
    await expect(sequelizeOf(db).query("SELECT * FROM docs", {
      model: db.models.Doc, mapToModel: true,
    })).rejects.toBeInstanceOf(ScopeDeniedError);
  });

  it("lets the same query through when it is bound to no model", async () => {
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    // Which tables an arbitrary string touches is not a question available at
    // this layer, so an unbound statement is not refused. That limit is exactly
    // why §12 refuses to *build* an unannotated raw-SQL method rather than
    // leaning on this.
    expect(await sequelizeOf(db).query("SELECT name FROM docs")).toBeDefined();
  });

  it("refuses nothing at all when no scope is configured", async () => {
    const db = await buildOrm();
    await seed(db);
    expect(await sequelizeOf(db).query("SELECT * FROM docs", {
      model: db.models.Doc, mapToModel: true,
    })).toBeDefined();
  });

  it("does not refuse the engine's own scoped queries", async () => {
    // The other 150-odd tests in this file are the real evidence — every one of
    // them runs with this hook armed — but the marking is subtle enough to be
    // worth stating once, where a reader looking at the backstop will find it.
    const db = await buildOrm({ scope: ownedBy(1) });
    await seed(db);
    const { total } = await db.resolveFindAll("Doc", null, {}, ctx(1));
    expect(total).toEqual(2);
    expect(await db.processCreate("Doc", null, { input: { name: "fresh", ownerId: 1 } }, ctx(1))).toHaveLength(1);
  });

  it("cannot be displaced by a beforeQuery a deployment registers", async () => {
    const seen: unknown[] = [];
    const db = await buildOrm({ scope: ownedBy(1) });
    // Global hooks run first and this one returns a value, which for an instance
    // hook is discarded. Neither it nor its ordering can stop what follows: the
    // enforcement is not in `globalHooks` at all.
    db.addHook("beforeQuery", ((options: unknown) => {
      seen.push(options);
      return undefined;
    }) as never);
    await seed(db);
    await expect(sequelizeOf(db).query("SELECT * FROM docs", {
      model: db.models.Doc, mapToModel: true,
    })).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(seen.length).toBeGreaterThan(0);
  });
});
