# @azerothian/ormize-adapter-valkey

A [Valkey](https://valkey.io/) / Redis backend adapter for [`@azerothian/ormize`](../ormize).

Objects are stored as typed JSON. Unlike a SQL backend, this adapter **never scans the keyspace** —
all retrieval is driven by secondary-index and mapping structures it maintains itself, so:

- **Queries only use indexed fields.** A `where` that can't be answered from an index is rejected
  rather than falling back to a scan.
- **Lookup / mapping tables** are generated for every indexed field and for relationship foreign
  keys, so relationship reads are index-driven too.
- **Object expiry (TTL)** cascades into the mapping data — an expired object is excluded from and
  purged out of every index it belonged to.
- **Transactions** are real: inside `orm.transaction(...)` writes buffer in a per-transaction
  in-memory overlay (with read-your-writes) and apply atomically via `MULTI`/`EXEC` on commit, or
  discard on rollback.

```ts
import { Ormize } from "@azerothian/ormize";
import ValkeyAdapter from "@azerothian/ormize-adapter-valkey";
import IORedis from "ioredis";

const orm = new Ormize();
orm.registerAdapter(new ValkeyAdapter({ prefix: "app" }, new IORedis(url)), "valkey");
```

See the [guide](../../docs/guide.md) and the runnable
[`examples/valkey-basic`](../../examples/valkey-basic) demo.
