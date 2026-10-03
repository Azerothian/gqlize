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
// WASM — the real `require`s stay inside the lazy `sharedPg()` below.
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

interface SharedPg {
  pglite: PGlite;
  server: PGLiteSocketServer;
  dir: string;
}
let shared: SharedPg | undefined;
let sharedInit: Promise<SharedPg> | undefined;

/**
 * One PGlite per test file. Jest gives every file a fresh module registry, so
 * this singleton is per file, not per test — paying the WASM start-up (about a
 * second) once rather than for every test.
 */
function sharedPg(): Promise<SharedPg> {
  if (!sharedInit) {
    sharedInit = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: a SQLite project must never load the WASM
      const { PGlite: PGliteCtor } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
      const { PGLiteSocketServer: ServerCtor } = require("@electric-sql/pglite-socket") as typeof import("@electric-sql/pglite-socket");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ormize-pglite-"));
      const pglite = await PGliteCtor.create();
      const server = new ServerCtor({
        db: pglite,
        path: path.join(dir, ".s.PGSQL.5432"),
        // Every open adapter holds one connection (`pool.max: 1` below); a
        // test that builds several at once — cross-adapter, transactions —
        // needs a few of them live together.
        maxConnections: 8,
      });
      await server.start();
      shared = { pglite, server, dir };
      return shared;
    })();
  }
  return sharedInit;
}

let schemaCounter = 0;

/** Sequelize connection options — kept loose: callers spread their own on top. */
export type DialectConfig = { [option: string]: unknown };

/**
 * Sequelize connection options for the current dialect, `overrides` on top.
 *
 * On Postgres every call gets a **schema of its own** and pins its connection
 * to it with `search_path`, rather than every adapter sharing (and resetting)
 * `public`. Two adapters open at once — a cross-adapter relationship, a
 * coordinated transaction, a suite seeded in `beforeAll` — then cannot see or
 * clobber each other's tables, exactly as two in-memory SQLite databases
 * cannot.
 */
export async function dialectConfig(overrides: DialectConfig = {}): Promise<DialectConfig> {
  if (testDialect() !== "postgres") {
    return { dialect: "sqlite", logging: false, ...overrides };
  }
  const pg = await sharedPg();
  const schema = `t_${process.pid}_${++schemaCounter}`;
  await pg.pglite.exec(`CREATE SCHEMA "${schema}";`);
  const overrideHooks = (overrides.hooks || {}) as { [name: string]: unknown };
  return {
    dialect: "postgres",
    host: pg.dir,
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "postgres",
    logging: false,
    // One connection per adapter: `search_path` is per connection, and a
    // second pooled connection would not have it.
    pool: { max: 1, min: 0, idle: 1000 },
    ...overrides,
    hooks: {
      ...overrideHooks,
      afterConnect: async (connection: { query(sql: string): Promise<unknown> }, config: unknown) => {
        await connection.query(`SET search_path TO "${schema}"`);
        const user = overrideHooks.afterConnect as ((c: unknown, cfg: unknown) => unknown) | undefined;
        if (user) {
          await user(connection, config);
        }
      },
    },
  };
}

/** Anything holding a Sequelize instance to close — the adapter, structurally. */
export type Closable = { sequelize: { close(): Promise<unknown> } };

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
  registerTeardown(async () => {
    await adapter.sequelize.close();
  }, options);
  return adapter;
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

/** Stop the file's PGlite and its socket server, if one was started. */
export async function shutdownShared(): Promise<void> {
  if (!shared) {
    return;
  }
  const s = shared;
  shared = undefined;
  sharedInit = undefined;
  try { await s.server.stop(); } catch { /* already stopped */ }
  try { await s.pglite.close(); } catch { /* already closed */ }
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* already gone */ }
}
