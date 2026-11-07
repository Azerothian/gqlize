# @azerothian/ormize-cache-ioredis

A Redis / [Valkey](https://valkey.io/) store for the [`@azerothian/ormize`](../ormize) read cache,
through [ioredis](https://github.com/redis/ioredis).

The read cache itself (keys, deduplication, exclusions, invalidation) lives in ormize, along with an
in-process `MemoryCacheStore`. This store keeps entries in Redis instead, so every process that
points at the same server and `prefix` shares one cache, and a write in any of them invalidates the
cached reads of all of them.

```ts
import { Ormize } from "@azerothian/ormize";
import { IORedisCacheStore } from "@azerothian/ormize-cache-ioredis";
import IORedis from "ioredis";

const orm = new Ormize({
  cache: {
    store: new IORedisCacheStore(new IORedis(process.env.REDIS_URL), {
      prefix: "app-cache",
      maxEntries: 50_000,
      maxSize: 512 * 1024 * 1024,
    }),
    ttl: 30_000,
    exclude: ["AuditLog"],
  },
});
```

`ioredis` is an optional peer dependency. Pass a client you already have, or a URL or ioredis options
and the store opens its own (which `store.quit()` then closes).

## Options

| Option | Default | |
| --- | --- | --- |
| `prefix` | `"ormize-cache"` | Namespaces every key, as a hash tag (`{prefix}:…`), so the cache sits in one Redis Cluster slot. |
| `maxEntries` | `10000` | Entries kept before the least recently used is evicted. `0` means no limit. |
| `maxSize` | `256 MiB` | Bytes (keys plus values) kept before the least recently used is evicted. `0` means no limit. |

## How it is laid out

| Key | Type | |
| --- | --- | --- |
| `{prefix}:e:<key>` | string | One cached result, with a `PX` expiry. |
| `{prefix}:lru` | sorted set | Entry keys scored by last use. The lowest score is evicted first. |
| `{prefix}:sizes`, `{prefix}:bytes` | hash, counter | Each entry's size and the running total, for `maxSize`. |
| `{prefix}:clock` | counter | The LRU score source. It is a counter, not a timestamp, so processes with skewed clocks still agree on the order. |
| `{prefix}:v:<model>` | counter | A model's generation. A write increments it. |

`set` and `get` are Lua scripts, so updating the LRU index and evicting are atomic with the read or
write. An entry that expires by TTL leaves its index rows behind until a `get` misses on it or
eviction reaches it. Until then the totals overstate what is held, which only means something gets
evicted a little early.

Invalidation never enumerates keys. Every cache key embeds the generations of the models its read
touched, so incrementing a generation makes those keys unreachable, and the old entries age out
through the LRU or their TTL.

`clear()` uses `SCAN`, so in a cluster it reaches only the node the client is connected to, which is
the node holding the prefix's slot.
