import { RedisMemoryServer } from "redis-memory-server";
import IORedis from "ioredis";

// One real redis-server (redis-memory-server) shared per test file; each test
// FLUSHALLs for isolation. Mirrors the PGlite pattern used by the gqlize suite.
let server: RedisMemoryServer | undefined;
let init: Promise<RedisMemoryServer> | undefined;

function getServer(): Promise<RedisMemoryServer> {
  if (!init) {
    init = (async () => {
      const s = new RedisMemoryServer();
      await s.getPort(); // triggers download/start
      server = s;
      return s;
    })();
  }
  return init;
}

const clients: IORedis[] = [];

export async function makeClient(): Promise<IORedis> {
  const s = await getServer();
  const host = await s.getHost();
  const port = await s.getPort();
  const client = new IORedis({ host, port, maxRetriesPerRequest: null, lazyConnect: false });
  clients.push(client);
  return client;
}

/** FLUSHALL for test isolation. */
export async function flush(client: IORedis): Promise<void> {
  await client.flushall();
}

export async function shutdown(): Promise<void> {
  for (const c of clients.splice(0)) {
    try { c.disconnect(); } catch { /* noop */ }
  }
  if (server) {
    await server.stop();
    server = undefined;
    init = undefined;
  }
}
