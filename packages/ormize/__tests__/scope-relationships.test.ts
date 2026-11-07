// Row-level scope tests: nested relationship mutations, relationship reads (F4),
// and cross-adapter proxies (F5).
// Split from scope.test.ts for readability.

import { describe, it, expect } from "@jest/globals";
import { ScopeDeniedError } from "../src/scope";
import {
  buildRelated, seedFolder, docsIn, scopeDoc, eagerDocs, ownedBy, ctx,
  buildCross, seedCross, scopeModel, named,
  type NamedRow, type OwnedRow,
} from "./helper/scope-fixtures";

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
