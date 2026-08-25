import os from "os";
import fs from "fs";
import path from "path";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { GqlizeAdapter } from "../../src/types";
// Type-only imports: erased at compile time, so the sqlite project still never
// actually loads the PGlite WASM module at runtime (the real `require`s stay
// inside the lazy `getSharedPg()` below) — these just give `SharedPg` real types.
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * Dialect-aware test adapter factory. The dialect is selected by the
 * `GQLIZE_DIALECT` env var (set per Jest project); defaults to sqlite.
 *
 * For postgres we run a real Postgres via PGlite (in-process WASM) exposed over a
 * unix-socket through @electric-sql/pglite-socket, so Sequelize's `postgres`
 * dialect talks to it with a real `pg` connection.
 *
 * The PGlite instance + socket server are shared for the whole test file (Jest
 * gives each test file a fresh module registry, so this singleton is effectively
 * one WASM Postgres per file, not per test). Each test gets an isolated schema by
 * dropping/recreating `public` before it connects a fresh Sequelize — this avoids
 * paying the ~1s PGlite/WASM startup on every test.
 */

export function currentDialect(): "sqlite" | "postgres" {
  return process.env.GQLIZE_DIALECT === "postgres" ? "postgres" : "sqlite";
}

interface SharedPg {
  pglite: PGlite;
  server: PGLiteSocketServer;
  dir: string;
}
let shared: SharedPg | undefined;
let sharedInit: Promise<SharedPg> | undefined;

function getSharedPg(): Promise<SharedPg> {
  if (!sharedInit) {
    sharedInit = (async () => {
      // Lazy require so the sqlite project never loads the PGlite WASM.
      const { PGlite } = require("@electric-sql/pglite");
      const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gqlize-pg-"));
      const pglite = await PGlite.create();
      const server = new PGLiteSocketServer({
        db: pglite,
        path: path.join(dir, ".s.PGSQL.5432"),
        maxConnections: 5,
      });
      await server.start();
      shared = { pglite, server, dir };
      return shared;
    })();
  }
  return sharedInit;
}

/** Stop the shared PGlite server (call from an afterAll in the Jest setup). */
export async function shutdownShared() {
  if (!shared) {
    return;
  }
  const s = shared;
  shared = undefined;
  sharedInit = undefined;
  try { await s.server.stop(); } catch (e) { /* noop */ }
  try { await s.pglite.close(); } catch (e) { /* noop */ }
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* noop */ }
}

// Per-test teardown registry (closes the per-test Sequelize connection); drained
// by an afterEach in the Jest setup file.
const teardowns: Array<() => Promise<void>> = [];
export function registerTeardown(fn: () => Promise<void>) {
  teardowns.push(fn);
}
export async function teardownAll() {
  const fns = teardowns.splice(0, teardowns.length);
  for (const fn of fns) {
    try {
      await fn();
    } catch (e) {
      // ignore teardown errors
    }
  }
}

export interface DialectAdapter {
  adapter: GqlizeAdapter;
  name: string;
  teardown: () => Promise<void>;
}

export async function createAdapterForDialect(): Promise<DialectAdapter> {
  if (currentDialect() === "postgres") {
    const s = await getSharedPg();
    // Clean slate for this test — the previous test's connection is already
    // closed by the afterEach teardown, so direct access is safe here.
    await s.pglite.exec("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const sequelizeAdapter = new SequelizeAdapter({}, {
      dialect: "postgres",
      host: s.dir,
      port: 5432,
      username: "postgres",
      password: "postgres",
      database: "postgres",
      logging: false,
      pool: { max: 1, min: 0, idle: 1000 },
    });
    const adapter = sequelizeAdapter as unknown as GqlizeAdapter;
    const teardown = async () => {
      // Closing over the concrete adapter (rather than the widened `GqlizeAdapter`
      // view) gives real access to `.sequelize` with no cast at all.
      try { await sequelizeAdapter.sequelize.close(); } catch (e) { /* noop */ }
    };
    return { adapter, name: "postgres", teardown };
  }

  const adapter = new SequelizeAdapter({}, { dialect: "sqlite" }) as unknown as GqlizeAdapter;
  return { adapter, name: "sqlite", teardown: async () => { /* in-memory, nothing to close */ } };
}
