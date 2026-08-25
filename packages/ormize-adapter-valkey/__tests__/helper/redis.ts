import { RedisMemoryServer } from "redis-memory-server";
import IORedis from "ioredis";

// One real redis-server shared per test file; each test FLUSHALLs for
// isolation. Mirrors the PGlite pattern used by the gqlize suite.
//
// `REDIS_URL` points at an already-running server and is what CI uses (a redis
// service container). Without it we fall back to redis-memory-server, which
// needs a redis-server binary. `allowBuilds` in pnpm-workspace.yaml lets its
// postinstall run, so that ~2 minute network fetch happens once at install time
// and is cached under node_modules/.cache — not inside the test run, where a
// stall would hang the job outright.
const REDIS_URL = process.env.REDIS_URL;

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
  const options = { maxRetriesPerRequest: null, lazyConnect: false };
  let client: IORedis;
  if (REDIS_URL) {
    client = new IORedis(REDIS_URL, {
      ...options,
      // An unreachable REDIS_URL is a misconfigured environment, not a blip.
      // Without a bounded strategy ioredis reconnects forever and the suite
      // hangs instead of reporting the problem. Keep the total well under
      // jest's `testTimeout` so the failure is the connection error, not an
      // uninformative hook timeout.
      connectTimeout: 2000,
      retryStrategy: (times: number) => (times > 2 ? null : 200),
    });
    client.on("error", () => { /* surfaced by the ping below */ });
    await client.ping();
  } else {
    const s = await getServer();
    client = new IORedis({ ...options, host: await s.getHost(), port: await s.getPort() });
  }
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
