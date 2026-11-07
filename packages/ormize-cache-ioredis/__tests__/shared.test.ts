import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, it, expect, beforeEach, afterAll} from "@jest/globals";
import Sequelize from "sequelize";
import {Ormize} from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type {Definition} from "@azerothian/ormize";
import {IORedisCacheStore} from "../src";
import {flush, makeClient, shutdown} from "./helper/redis";

// Two "processes": two engines over one SQLite file, sharing one Redis. The
// point of this store over the in-memory one is that a write through either
// engine invalidates what the other has cached.

const tag: Definition = {name: "Tag", define: {name: {type: Sequelize.STRING, allowNull: false}}};
const dir = mkdtempSync(path.join(tmpdir(), "ormize-cache-"));
const adapters: SequelizeAdapter[] = [];

async function engine(storage: string) {
  const client = await makeClient();
  const db = new Ormize({cache: {store: new IORedisCacheStore(client), onError: (e) => { throw e; }}});
  const adapter = new SequelizeAdapter({}, {dialect: "sqlite", storage, logging: false});
  adapters.push(adapter);
  db.registerAdapter(adapter, "sqlite");
  await db.addDefinition(tag);
  await db.initialise();
  await db.sync();
  return db;
}

const names = async(db: Ormize) =>
  (await db.resolveFindAll("Tag", undefined, {}, {})).models.map((m) => (m as {get: (k: string) => unknown}).get("name")).sort();

beforeEach(async() => {
  await flush(await makeClient());
});

afterAll(async() => {
  for (const adapter of adapters.splice(0)) {
    await adapter.sequelize.close();
  }
  await shutdown();
  rmSync(dir, {recursive: true, force: true});
});

describe("IORedisCacheStore shared between engines", () => {
  it("serves one engine's cached read to the other, and invalidates both on a write", async() => {
    const storage = path.join(dir, "shared.sqlite");
    const one = await engine(storage);
    const two = await engine(storage);
    await one.processCreate("Tag", undefined, {input: {name: "red"}}, {});

    expect(await names(one)).toEqual(["red"]);
    // Written behind both engines' backs: only a cached read still says "red" alone.
    await (adapters[0].sequelize).query(`INSERT INTO "Tags" ("name", "createdAt", "updatedAt") VALUES ('raw', '2020-01-01', '2020-01-01')`);
    expect(await names(two)).toEqual(["red"]);

    await two.processCreate("Tag", undefined, {input: {name: "blue"}}, {});
    expect(await names(one)).toEqual(["blue", "raw", "red"]);
  });
});
