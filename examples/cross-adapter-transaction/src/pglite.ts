import os from "os";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * Boot an in-process Postgres (PGlite, WASM) and expose it over a unix socket via
 * @electric-sql/pglite-socket, so Sequelize's real `postgres` dialect can connect
 * to it with an ordinary `pg` connection — no external Postgres server needed.
 *
 * Returns the socket directory (what Sequelize connects to as `host`) plus a
 * `shutdown()` that stops the server and cleans up.
 */
export async function startPglite(): Promise<{ dir: string; shutdown: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ormize-pg-"));
  const pglite = await PGlite.create();
  const server = new PGLiteSocketServer({
    db: pglite,
    path: path.join(dir, ".s.PGSQL.5432"),
    maxConnections: 5,
  });
  await server.start();
  return {
    dir,
    shutdown: async () => {
      try { await server.stop(); } catch { /* noop */ }
      try { await pglite.close(); } catch { /* noop */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}
