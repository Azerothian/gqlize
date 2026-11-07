// Shared fixtures for the row-level scope suites (`scope-*.test.ts`): the
// models, seeding and request-context helpers they all build on.

import Database from "../../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import type { Permission, ScopePredicate } from "@azerothian/utilize/gate";
import type { HookMap } from "../../src/types";
import { dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";

// -------------------------------------------------------------------------
// Single-model helpers (Doc)
// -------------------------------------------------------------------------

/** Just the slice of a `definition.before` request these tests read. */
export type BeforeRequest = { type: unknown; params: { where?: unknown } };
/** Rows come back as opaque adapter instances; these are the columns read back. */
export type NamedRow = { name: string };
export type OwnedRow = { ownerId: number };

// One flat model. `ownerId` is an ordinary column rather than a relationship's
// foreign key, so it survives `isStructurallyWritable` — which is what lets the
// forged-value tests send it at all. A scope over a real FK is the easier case:
// the allow-list has already dropped the client's value before `set` runs.
export async function buildOrm(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
  before?: (req: BeforeRequest) => unknown;
  hooks?: HookMap;
  classMethods?: {[name: string]: unknown};
  instanceMethods?: {[name: string]: unknown};
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({
    permission,
    onScopeMiss: options.onScopeMiss,
  });
  db.registerAdapter(
    trackConnection(new SequelizeAdapter({}, await dialectConfig())),
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
    classMethods: options.classMethods as never,
    instanceMethods: options.instanceMethods as never,
  });
  await db.initialise();
  await db.sync();
  return db;
}

export type Orm = Awaited<ReturnType<typeof buildOrm>>;

export async function seed(db: Orm) {
  await db.models.Doc.bulkCreate([
    { name: "mine-1", ownerId: 1 },
    { name: "mine-2", ownerId: 1 },
    { name: "theirs", ownerId: 2 },
  ]);
}

/** "Only the rows you own", the canonical scope. */
export const ownedBy = (id: number): ScopePredicate => () => ({ where: { ownerId: { eq: id } } });

export const ctx = (id: number) => ({ user: { id } });

// -------------------------------------------------------------------------
// Two-model helpers (Folder hasMany Doc)
// -------------------------------------------------------------------------

// A `Folder hasMany Doc` pair, so the nested-mutation verbs have a target model
// to reach. Only `Doc` is scoped: the verbs run against the *target*, and a
// scoped source would confuse which of the two a blocked write was blocked by.
export async function buildRelated(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({
    permission,
    onScopeMiss: options.onScopeMiss,
  });
  db.registerAdapter(
    trackConnection(new SequelizeAdapter({}, await dialectConfig())),
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

export type Related = Awaited<ReturnType<typeof buildRelated>>;

/** A folder holding one owned and one unowned doc — the pair every verb below sorts. */
export async function seedFolder(db: Related, attached: boolean) {
  const folder = await db.models.Folder.create({ title: "f" });
  const folderId = attached ? folder.id : null;
  await db.models.Doc.bulkCreate([
    { name: "mine", ownerId: 1, folderId },
    { name: "theirs", ownerId: 2, folderId },
  ]);
  return folder;
}

/** Which docs the folder currently holds, by name. */
export async function docsIn(db: Related, folder: { id: unknown }) {
  const rows = await db.models.Doc.findAll({ where: { folderId: folder.id } });
  return (rows as NamedRow[]).map((r) => r.name).sort();
}

export const scopeDoc = (fn: ScopePredicate): ScopePredicate =>
  (defName, operation, options, context) =>
    (defName === "Doc" ? fn(defName, operation, options, context) : undefined);

/** The eager plan gqlize would build for `folders { docs { … } }`. */
export const eagerDocs = () => ({ include: [{ docs: { target: "Doc", associationType: "hasMany" } }] });

// -------------------------------------------------------------------------
// Cross-adapter helpers (Vault, File, Tag on two sqlite adapters)
// -------------------------------------------------------------------------

// Two sqlite adapters is all "cross-adapter" means to the engine: the two ends
// have different `OrmAdapter` instances, so there is no association to delegate
// to and ormize resolves the pair itself. `Vault` lives on one, `File` and `Tag`
// on the other, so every relationship below takes the proxy path.
export async function buildCross(options: {
  scope?: ScopePredicate;
  onScopeMiss?: "empty" | "throw";
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission, onScopeMiss: options.onScopeMiss });
  db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite");
  db.registerAdapter(trackConnection(new SequelizeAdapter({}, await dialectConfig())), "sqlite2");
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

export type Cross = Awaited<ReturnType<typeof buildCross>>;

/** A vault holding one owned and one unowned file, plus one tag linked to it. */
export async function seedCross(db: Cross) {
  const vault = await db.models.Vault.create({ title: "v" });
  await db.models.File.bulkCreate([
    { name: "mine", ownerId: 1, vaultId: vault.id },
    { name: "theirs", ownerId: 2, vaultId: vault.id },
  ]);
  const tag = await db.models.Tag.create({ label: "t" });
  return { vault, tag };
}

export const scopeModel = (name: string, fn: ScopePredicate): ScopePredicate =>
  (defName, operation, options, context) =>
    (defName === name ? fn(defName, operation, options, context) : undefined);

export const named = (rows: unknown) => (rows as NamedRow[]).map((r) => r.name).sort();
