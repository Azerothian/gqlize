import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { MemoryCacheStore } from "@azerothian/ormize";
import type { Ormize } from "@azerothian/ormize";
import { NestizeModule } from "../src";
import { buildOrm } from "./helper";

// The read cache under the REST projection. Every list, `count`, single-row
// read, relation route and query action goes through `resolveFindAll`, and
// the last two run their accessor or method on the row it returns, which on a
// hit is a row the cache rebuilt. Each request runs against an app with no cache
// for the expected body, and against a cached app as a miss, as a hit with no
// database calls, and again after the same writes on both.

type App = { app: INestApplication<Server>, http: Server, orm: Ormize, reads: () => number };

async function boot(cached: boolean): Promise<App> {
  const orm = await buildOrm(cached ? { cache: { store: new MemoryCacheStore(), onError: (e) => { throw e; } } } : undefined);
  const adapter = orm.adapters[Object.keys(orm.adapters)[0]];
  const spies = [jest.spyOn(adapter, "findAll"), jest.spyOn(adapter, "count")];
  const moduleRef = await Test.createTestingModule({ imports: [NestizeModule.forRoot(orm, { expose: { instanceMethods: true } })] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return { app, http: app.getHttpServer(), orm, reads: () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0) };
}

const filter = (where: object) => `filter=${encodeURIComponent(JSON.stringify(where))}`;

async function seed(http: Server) {
  const box = (await request(http).post("/item").send({ label: "box" })).body as { id: unknown };
  const bag = (await request(http).post("/item").send({ label: "bag" })).body as { id: unknown };
  for (const [name, itemId, done] of [["alpha", box.id, false], ["beta", box.id, true], ["gamma", bag.id, false], ["delta", null, true], ["epsilon", box.id, false]] as const) {
    const res = await request(http).post("/task").send({ name, itemId, done });
    expect(res.status).toBe(201);
  }
  return { box: box.id, bag: bag.id };
}

function routes(ids: { box: unknown, bag: unknown }): string[] {
  return [
    "/task",
    "/task?order=name",
    "/task?order=-name",
    "/task?order=done,-name",
    `/task?${filter({ done: { eq: true } })}`,
    `/task?${filter({ name: { in: ["alpha", "gamma"] } })}`,
    `/task?${filter({ or: [{ name: { like: "%ta" } }, { done: { eq: true } }] })}&order=-name`,
    "/task?limit=2&order=name",
    "/task?limit=2&offset=2&order=name",
    "/task?count=only",
    `/task?count=only&${filter({ done: { eq: false } })}`,
    "/task/1",
    "/task/3",
    "/item?order=label",
    `/item/${String(ids.box)}`,
    `/item/${String(ids.box)}/tasks`,
    `/item/${String(ids.bag)}/tasks`,
    "/task/1/_actions/describe",
    "/task/4/_actions/describe",
  ];
}

async function bodies(http: Server, list: string[]) {
  const out: Record<string, unknown> = {};
  for (const route of list) {
    // An instance action is POST-only; a query method such as `describe` still
    // only reads, and runs on the row `loadInstance` fetched.
    const res = route.includes("/_actions/") ? await request(http).post(route).send({}) : await request(http).get(route);
    out[route] = { status: res.status, body: res.body as unknown, text: res.text };
  }
  return out;
}

async function write(http: Server, ids: { box: unknown, bag: unknown }) {
  expect((await request(http).patch(`/task?${filter({ name: { eq: "alpha" } })}`).send({ name: "aardvark", done: true })).status).toBe(200);
  expect((await request(http).delete(`/task?${filter({ name: { eq: "gamma" } })}`)).status).toBe(200);
  expect((await request(http).post("/task").send({ name: "zeta", itemId: ids.bag })).status).toBe(201);
  expect((await request(http).post("/task/1/_actions/appendSuffix").send({ suffix: "?" })).status).toBeLessThan(300);
  expect((await request(http).patch(`/item?${filter({ label: { eq: "box" } })}`).send({ label: "crate" })).status).toBe(200);
}

describe("nestize - read cache", () => {
  let plain: App;
  let cached: App;

  beforeAll(async () => {
    plain = await boot(false);
    cached = await boot(true);
  });

  afterAll(async () => {
    await plain.app.close();
    await cached.app.close();
  });

  it("answers every REST read from the cache exactly as the database would, before and after writes", async () => {
    const ids = await seed(plain.http);
    expect(await seed(cached.http)).toEqual(ids);
    const list = routes(ids);

    const expected = await bodies(plain.http, list);
    for (const route of list) {
      expect({ route, status: (expected[route] as { status: number }).status }).toEqual({ route, status: route.includes("/_actions/") ? 201 : 200 });
    }
    // The query action really ran on a row: `describe` answers in plain text.
    expect((expected["/task/1/_actions/describe"] as { text: string }).text).toBe("task:alpha");
    expect(await bodies(cached.http, list)).toEqual(expected);
    const before = cached.reads();
    expect(await bodies(cached.http, [...list].reverse())).toEqual(expected);
    expect(cached.reads()).toBe(before);

    await write(plain.http, ids);
    await write(cached.http, ids);
    const after = await bodies(plain.http, list);
    expect(after).not.toEqual(expected);
    expect(await bodies(cached.http, list)).toEqual(after);
  });
});
