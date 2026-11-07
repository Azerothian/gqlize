import {describe, it, expect, afterAll} from "@jest/globals";
import {cacheEntryKey} from "@azerothian/utilize/utils/cache-key";
import {IORedisCacheStore} from "../../src";
import {flush, makeClient, shutdown} from "../helper/redis";

// Opt-in benchmark; not part of `pnpm test`.
//
//   pnpm --filter @azerothian/ormize-cache-ioredis exec jest \
//     --testMatch '**/__tests__/bench/*.bench.ts' --coverage=false
//
// A cache hit used to be two round trips (`versions`, then `get`); `lookup` is
// one. Against a local server the gap is the per-call overhead. Over a network
// each saved call is a full round trip, so the gap grows with the latency.

afterAll(shutdown);

async function median(iterations: number, fn: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < iterations + 50; i++) {
    const start = performance.now();
    await fn();
    if (i >= 50) {
      samples.push(performance.now() - start);
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("IORedisCacheStore benchmark", () => {
  it("one-call lookup against versions + get", async() => {
    const client = await makeClient();
    await flush(client);
    const store = new IORedisCacheStore(client);
    const tags = ["Author", "Book", "BookTags", "Tag"];
    const value = "x".repeat(4096);
    await store.set(cacheEntryKey("shape", await store.versions(tags)), value, 600_000);

    const twoCalls = await median(2000, async() => store.get(cacheEntryKey("shape", await store.versions(tags))));
    const oneCall = await median(2000, () => store.lookup("shape", tags));
    expect((await store.lookup("shape", tags)).value).toBe(value);
    console.log(`hit, 4 tags, 4 KiB: versions + get ${twoCalls.toFixed(3)} ms | lookup ${oneCall.toFixed(3)} ms`);
  });
});
