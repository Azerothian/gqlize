// Instance-method transforms on the REST CSV routes: `?apply=` on
// `POST /:resource/_csv/:operation`, and a `<field>.apply` text part on
// `POST /_csv`. Held to the same rules as the instance-method route: only
// exposed transforms, `mutationInstanceMethods` deciding which may run.
import { describe, it, expect, afterEach } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NestizeModule } from "../src";
import type { NestizeOptions } from "../src";
import type { Ormize } from "@azerothian/ormize";
import { buildOrm } from "./helper";

type Row = { [key: string]: unknown };

let app: INestApplication<Server> | undefined;

async function start(options?: NestizeOptions) {
  const orm = await buildOrm({ csv: { maxRows: 10, maxFiles: 3 } });
  const moduleRef = await Test.createTestingModule({ imports: [NestizeModule.forRoot(orm, options)] }).compile();
  app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return { orm, http: app.getHttpServer() };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const postCsv = (http: Server, path: string, body: string, apply?: string) => {
  const req = request(http).post(path).set("content-type", "text/csv");
  return (apply === undefined ? req : req.query({ apply })).send(body);
};

async function names(orm: Ormize): Promise<string[]> {
  return ((await orm.models.Task.findAll({ order: [["id", "ASC"]] })) as { get(o: Row): Row }[])
    .map((r) => r.get({ plain: true }).name as string);
}

describe("nestize - CSV apply", () => {
  it("runs the transforms on each created row", async () => {
    const { orm, http } = await start();
    const res = await postCsv(http, "/task/_csv/create", "name\na\nb\n", JSON.stringify({ appendSuffix: { suffix: "?" } }));
    expect(res.status).toBe(200);
    expect(await names(orm)).toEqual(["a?", "b?"]);
  });

  it("runs them on rows an update picks by key columns alone", async () => {
    const { orm, http } = await start();
    await orm.models.Task.create({ name: "a" });
    await orm.models.Task.create({ name: "b" });
    const res = await postCsv(http, "/task/_csv/update?keys=name", "name\nb\n", JSON.stringify({ rename: true }));
    expect(res.status).toBe(200);
    expect(await names(orm)).toEqual(["a", "renamed"]);
  });

  it("refuses unknown, malformed or misplaced transforms, writing nothing", async () => {
    const { orm, http } = await start();
    for (const apply of ["{\"describe\":true}", "{\"nope\":true}", "{\"rename\":3}", "[\"rename\"]", "rename", "{\"__proto__\":true}"]) {
      const res = await postCsv(http, "/task/_csv/create", "name\na\n", apply);
      expect([apply, res.status, res.body.code]).toEqual([apply, 400, "CSV_UNSUPPORTED"]);
    }
    const del = await postCsv(http, "/task/_csv/delete", "id\n1\n", JSON.stringify({ rename: true }));
    expect([del.status, del.body.code]).toEqual([400, "CSV_UNSUPPORTED"]);
    expect(await names(orm)).toEqual([]);
  });

  it("refuses a transform the permissions deny", async () => {
    const { orm, http } = await start({ permission: { mutationInstanceMethods: (_d: string, m: string) => m !== "rename" } });
    expect((await postCsv(http, "/task/_csv/create", "name\na\n", JSON.stringify({ rename: true }))).status).toBe(403);
    expect(await names(orm)).toEqual([]);
  });

  it("takes a file's transforms from its `.apply` part in a multi-file import", async () => {
    const { orm, http } = await start({ permission: { mutationInstanceMethods: (_d: string, m: string) => m !== "rename" } });
    const send = (apply: string) => request(http).post("/_csv")
      .field("task.create.apply", apply)
      .attach("task.create", Buffer.from("name\na\n"), "task.csv");
    expect((await send(JSON.stringify({ rename: true }))).status).toBe(403);
    expect((await send(JSON.stringify({ nope: true }))).status).toBe(400);
    expect(await names(orm)).toEqual([]);
    expect((await send(JSON.stringify({ appendSuffix: true }))).status).toBe(200);
    expect(await names(orm)).toEqual(["a!"]);
  });
});
