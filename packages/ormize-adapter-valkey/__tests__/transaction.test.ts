import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { AdapterQueryOptions, AdapterWhere } from "@azerothian/utilize/types/index";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;
let adapter: ValkeyAdapter;

const UserDef = {
  name: "User",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    email: { type: DataTypes.String, unique: true },
    role: { type: DataTypes.String, index: true },
  },
  options: {},
};

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => {
  await flush(client);
  adapter = new ValkeyAdapter({ prefix: "tx" }, client);
  await adapter.createModel(UserDef);
});

const find = (where?: AdapterWhere, options?: AdapterQueryOptions) => adapter.findAll("User", { where, ...options });

describe("valkey adapter — transactions (MULTI/EXEC + overlay)", () => {
  it("commit persists all buffered writes atomically", async () => {
    const { handle, commit } = await adapter.beginTransaction();
    await adapter.getCreateFunction("User")({ email: "a@x.com", role: "admin" }, { transaction: handle });
    await adapter.getCreateFunction("User")({ email: "b@x.com", role: "admin" }, { transaction: handle });
    // Not visible outside the tx before commit.
    expect(await find({ role: "admin" })).toHaveLength(0);
    await commit();
    expect(await find({ role: "admin" })).toHaveLength(2);
  });

  it("rollback discards everything (nothing hit redis)", async () => {
    const { handle, rollback } = await adapter.beginTransaction();
    await adapter.getCreateFunction("User")({ email: "a@x.com", role: "admin" }, { transaction: handle });
    await rollback();
    expect(await find({ role: "admin" })).toHaveLength(0);
  });

  it("read-your-writes inside a transaction", async () => {
    const { handle, commit } = await adapter.beginTransaction();
    await adapter.getCreateFunction("User")({ email: "a@x.com", role: "admin" }, { transaction: handle });
    // A query on the SAME transaction sees the buffered write via the overlay.
    const inTx = await find({ role: "admin" }, { transaction: handle });
    expect(inTx).toHaveLength(1);
    expect(inTx[0].email).toBe("a@x.com");
    await commit();
  });
});
