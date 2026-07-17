import IORedis from "ioredis";

/**
 * A connected ioredis client. Uses REDIS_URL if set (a real Valkey/Redis), else
 * boots an ephemeral in-process redis via redis-memory-server so the demo runs
 * out of the box with no external server.
 */
export async function connect(): Promise<{ client: IORedis; shutdown: () => Promise<void> }> {
  if (process.env.REDIS_URL) {
    const client = new IORedis(process.env.REDIS_URL);
    return { client, shutdown: async () => { client.disconnect(); } };
  }
  const { RedisMemoryServer } = require("redis-memory-server");
  const server = new RedisMemoryServer();
  const host = await server.getHost();
  const port = await server.getPort();
  const client = new IORedis({ host, port });
  return {
    client,
    shutdown: async () => { client.disconnect(); await server.stop(); },
  };
}
