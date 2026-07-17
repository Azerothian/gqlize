# @azerothian/ormize-adapter-valkey

A [Valkey](https://valkey.io/) / Redis backend adapter for [`@azerothian/ormize`](../ormize).

Objects are stored as typed JSON. Unlike a SQL backend, this adapter **never scans the keyspace** —
all retrieval is driven by secondary-index and mapping structures it maintains itself, so:

- **Queries only use indexed fields.** A `where` that can't be answered from an index is rejected
  rather than falling back to a scan.
- **Lookup / mapping tables** are generated for every indexed field and for relationship foreign
  keys, so relationships are index-driven. All four relation types are supported — hasOne/belongsTo/
  hasMany via foreign-key maps and belongsToMany via a join model — including nested relationship
  mutation input, the same as the Sequelize adapter.
- **Object expiry (TTL)** cascades into the mapping data — an expired object is excluded from and
  purged out of every index it belonged to.
- **Sequelize-style model API** is supported too: static `orm.models.X.create/findAll/findByPk/count/
  update/destroy`, instance `row.save/update/destroy/reload/get/toJSON`, definition `classMethods`/
  `instanceMethods`, and relationship finders (`author.getPosts()`, `addPost`, `countPosts`, …) — the
  same surface as the Sequelize adapter.
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
