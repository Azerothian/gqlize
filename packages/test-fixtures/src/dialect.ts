// The test database every Sequelize-backed suite in this repo runs against:
// SQLite in memory, or Postgres through PGlite (https://pglite.dev/) — a real
// Postgres compiled to WASM, run in-process and served over a unix socket by
// `@electric-sql/pglite-socket`, so Sequelize's ordinary `pg` dialect talks to
// it with no server installed anywhere. The Jest project picks which (see
// `./jest/dialect-*`), so the same suite runs on both.
//
// Structural on purpose: nothing here imports the Sequelize adapter. The
// adapter's own suites depend on this package, so importing it back would
// make a workspace cycle; callers construct the adapter and hand it over.

import os from "os";
import fs from "fs";
import path from "path";
// Type-only: erased at compile time, so a SQLite run never loads the PGlite
// WASM — the real `require`s stay inside the lazy `startSlot()` below.
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export type TestDialect = "sqlite" | "postgres";

/**
 * The dialect this Jest project runs on. `TEST_DIALECT` is set by the setup
 * module of each project; `GQLIZE_DIALECT` is the older spelling gqlize's
 * setup files used, still honoured. Anything else means SQLite.
 */
export function testDialect(): TestDialect {
  const value = process.env.TEST_DIALECT || process.env.GQLIZE_DIALECT;
  return value === "postgres" ? "postgres" : "sqlite";
}

/** One PGlite database and the socket that serves it. */
interface PgSlot {
  pglite: PGlite;
  server: PGLiteSocketServer;
  dir: string;
}
// The file's databases, and the tag of the adapter using each (`undefined`
// when free). Jest gives every file a fresh module registry, so this pool is
// per file.
const slots: Array<Promise<PgSlot>> = [];
const holders: Array<string | undefined> = [];

/**
 * Start a PGlite and serve it on its own unix socket. Lazy `require`, so a
 * SQLite project never loads the WASM.
 */
async function startSlot(): Promise<PgSlot> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: a SQLite project must never load the WASM
  const { PGlite: PGliteCtor } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
  const { PGLiteSocketServer: ServerCtor } = require("@electric-sql/pglite-socket") as typeof import("@electric-sql/pglite-socket");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ormize-pglite-"));
  const pglite = await PGliteCtor.create();
  const server = new ServerCtor({ db: pglite, path: path.join(dir, ".s.PGSQL.5432") });
  await server.start();
  return { pglite, server, dir };
}

let tagCounter = 0;

/** Sequelize connection options — kept loose: callers spread their own on top. */
export type DialectConfig = { [option: string]: unknown };

/**
 * Sequelize connection options for the current dialect, `overrides` on top.
 *
 * On Postgres every adapter gets a whole database to itself, its `public`
 * schema reset to empty — exactly what an application sees on a real server.
 * That matters: Sequelize's Postgres paths assume `public` (`sync({force:
 * true})`, so `adapter.reset()`, introspects it; enum types are looked up in
 * it), so isolating adapters by schema broke them.
 *
 * The databases are PGlite instances kept in a small per-file pool. The first
 * adapter uses the first, and each later one reuses any whose adapter has been
 * closed (through `trackConnection` / `closeConnection`). Another instance
 * starts only when adapters are open *at the same time* — a cross-adapter
 * relationship, a suite seeded in `beforeAll` alongside per-test ones — so the
 * WASM start-up (about a second) is paid once per file in the ordinary case.
 */
export async function dialectConfig(overrides: DialectConfig = {}): Promise<DialectConfig> {
  if (testDialect() !== "postgres") {
    return { dialect: "sqlite", logging: false, ...overrides };
  }
  const tag = `ormize-test-${process.pid}-${++tagCounter}`;
  let index = holders.findIndex((holder) => holder === undefined);
  if (index === -1) {
    index = slots.length;
    slots.push(startSlot());
  }
  holders[index] = tag;
  const slot = await slots[index];
  // `CREATE SCHEMA` alone leaves `public` usable only by its owner. A fresh
  // Postgres database grants USAGE on it to PUBLIC, and the RLS suites run
  // queries as a non-superuser role (`SET LOCAL ROLE`), which without the
  // grant silently skips the schema and reports every table as missing.
  await slot.pglite.exec("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;");
  const overrideDialectOptions = (overrides.dialectOptions || {}) as { [name: string]: unknown };
  return {
    dialect: "postgres",
    host: slot.dir,
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "postgres",
    logging: false,
    // PGlite is a single Postgres backend: one connection per adapter.
    pool: { max: 1, min: 0, idle: 1000 },
    ...overrides,
    // `application_name` doubles as the tag `closeConnection` reads to free
    // this adapter's database for the next one.
    dialectOptions: { ...overrideDialectOptions, application_name: tag },
  };
}

/** Anything holding a Sequelize instance to close — the adapter, structurally. */
export type Closable = { sequelize: { close(): Promise<unknown>; options?: { dialectOptions?: unknown } } };

// Connections closed after each test, and after each file (`suite`): a
// database built once in a `beforeAll` has to outlive the per-test teardown.
const testTeardowns: Array<() => Promise<void>> = [];
const suiteTeardowns: Array<() => Promise<void>> = [];

/** Register a teardown to run after the current test (or, with `suite`, after the file). */
export function registerTeardown(fn: () => Promise<void>, options: { suite?: boolean } = {}): void {
  (options.suite ? suiteTeardowns : testTeardowns).push(fn);
}

/** Close `adapter`'s connection after the current test (or, with `suite`, after the file). */
export function trackConnection<T extends Closable>(adapter: T, options: { suite?: boolean } = {}): T {
  registerTeardown(() => closeConnection(adapter), options);
  return adapter;
}

/** Close `adapter`'s connection now, freeing its database for the next adapter. */
export async function closeConnection(adapter: Closable): Promise<void> {
  await adapter.sequelize.close();
  const tag = (adapter.sequelize.options?.dialectOptions as { application_name?: string } | undefined)?.application_name;
  const index = tag === undefined ? -1 : holders.indexOf(tag);
  if (index !== -1) {
    holders[index] = undefined;
  }
}

async function drain(fns: Array<() => Promise<void>>): Promise<void> {
  for (const fn of fns.splice(0, fns.length)) {
    try {
      await fn();
    } catch {
      // A teardown that fails has nothing left to clean up for the next test.
    }
  }
}

/** Close every per-test connection. Run by `jest/teardown` after each test. */
export function teardownAll(): Promise<void> {
  return drain(testTeardowns);
}

/** Close every suite-scoped connection. Run by `jest/teardown` after the file. */
export function teardownSuite(): Promise<void> {
  return drain(suiteTeardowns);
}

// --- RLS test helpers (RFC §8) ---

/**
 * PGlite role helper for RLS tests. Creates a NOLOGIN role, grants it
 * privileges on the named tables, and runs a callback in a transaction with
 * `SET LOCAL ROLE` and `set_config(…, true)` for each setting.
 *
 * Every RLS test must switch role (PGlite connects as a superuser that owns
 * the tables, and superusers bypass RLS).
 */
export interface RlsRoleHelper {
  /**
   * Run `fn` under the named role with the given settings applied.
   *
   * @param role     The database role name.
   * @param settings Map of `{settingName: value}`.
   * @param fn       The callback. Receives a Sequelize-compatible options object
   *                 with the transaction handle.
   */
  asRole(
    role: string,
    settings: { [settingName: string]: string },
    fn: (options: { transaction: unknown }) => Promise<void>,
  ): Promise<void>;
}

/**
 * Build an RLS role helper for a given adapter.
 *
 * @param adapter  The Sequelize adapter instance (structurally: needs
 *                 `sequelize` with `query` and `transaction`).
 * @param tables   Table names to grant privileges on.
 * @param roles    Role names to create upfront (NOLOGIN).
 */
export async function createRlsRoleHelper(
  adapter: { sequelize: { query(sql: string, options?: unknown): Promise<unknown>; transaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> } },
  tables: string[],
  roles: string[],
): Promise<RlsRoleHelper> {
  const { sequelize } = adapter;

  // Create roles and grant privileges. Each statement separate (PGlite).
  for (const role of roles) {
    const [existing] = await sequelize.query(
      `SELECT 1 FROM pg_roles WHERE rolname = '${role}'`,
    ) as [Array<unknown>, unknown];
    if ((existing).length === 0) {
      await sequelize.query(`CREATE ROLE "${role}" NOLOGIN`);
      // The role needs to be a member of the current user to allow SET LOCAL ROLE.
      await sequelize.query(`GRANT "${role}" TO CURRENT_USER`);
    }
    for (const table of tables) {
      await sequelize.query(`GRANT ALL ON "${table}" TO "${role}"`);
    }
  }

  return {
    async asRole(
      role: string,
      settings: { [settingName: string]: string },
      fn: (options: { transaction: unknown }) => Promise<void>,
    ): Promise<void> {
      await sequelize.transaction(async (t: unknown) => {
        const opts = { transaction: t };
        // Apply settings
        for (const [name, value] of Object.entries(settings)) {
          await sequelize.query(
            `SELECT set_config('${name}', '${value}', true)`,
            opts,
          );
        }
        // Switch role
        await sequelize.query(`SET LOCAL ROLE "${role}"`, opts);

        // SET LOCAL ROLE is transaction-scoped — it reverts at COMMIT/ROLLBACK.
        await fn(opts);
      });
    },
  };
}

/** Stop every PGlite this file started, and their socket servers. */
export async function shutdownShared(): Promise<void> {
  const started = slots.splice(0, slots.length);
  holders.splice(0, holders.length);
  for (const pending of started) {
    try {
      const slot = await pending;
      try { await slot.server.stop(); } catch { /* already stopped */ }
      try { await slot.pglite.close(); } catch { /* already closed */ }
      try { fs.rmSync(slot.dir, { recursive: true, force: true }); } catch { /* already gone */ }
    } catch {
      // A slot that never started has nothing to stop.
    }
  }
}
