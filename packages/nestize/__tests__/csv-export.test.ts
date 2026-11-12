// `GET /:resource/_csv`: CSV export, the read side of the CSV upload routes.
// The rows the list route would return, as CSV, under the same guards.
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NestizeModule, buildOpenApiDocument } from "../src";
import type { NestizeOptions } from "../src";
import type { GqlizeOptions } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import { buildOrm } from "./helper";

async function start(ormOptions: GqlizeOptions, nestizeOptions?: NestizeOptions) {
  const orm = await buildOrm(ormOptions);
  const moduleRef = await Test.createTestingModule({
    imports: [NestizeModule.forRoot(orm, nestizeOptions)],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return { orm, app, http: app.getHttpServer() };
}

const lines = (text: string) => text.split("\r\n").filter((l) => l !== "");

describe("nestize - CSV export", () => {
  let app: INestApplication<Server>;
  let http: Server;
  let orm: Ormize;

  beforeAll(async () => {
    ({ app, http, orm } = await start({ csv: { maxRows: 3 } }));
    for (const name of ["e-a", "e-b", "e-c", "e-d"]) {
      await request(http).post("/task").send({ name, done: name === "e-b" });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("writes the listed rows as text/csv, with \\N for null", async () => {
    const filter = JSON.stringify({ name: { in: ["e-a", "e-b"] } });
    const res = await request(http).get("/task/_csv").query({ filter, order: "name", columns: "name,done,itemId" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(lines(res.text)).toEqual(["name,done,itemId", "e-a,false,\\N", "e-b,true,\\N"]);
  });

  it("caps the rows at the model's maxRows", async () => {
    const res = await request(http).get("/task/_csv").query({ limit: 100, columns: "name" });
    expect(lines(res.text)).toHaveLength(1 + 3);
  });

  it("defaults to every readable column, and takes a delimiter and no header", async () => {
    const all = await request(http).get("/task/_csv").query({ limit: 1 });
    expect(lines(all.text)[0].split(",")).toEqual(expect.arrayContaining(["id", "name", "done"]));
    const res = await request(http).get("/task/_csv")
      .query({ filter: JSON.stringify({ name: { eq: "e-c" } }), columns: "name,done", delimiter: ";", header: "false" });
    expect(lines(res.text)).toEqual(["e-c;false"]);
  });

  it("refuses an unknown column, a non-operator filter and a bad delimiter with 400", async () => {
    expect((await request(http).get("/task/_csv").query({ columns: "name,nope" })).status).toBe(400);
    expect((await request(http).get("/task/_csv").query({ filter: JSON.stringify({ name: { col: "name" } }) })).status).toBe(400);
    expect((await request(http).get("/task/_csv").query({ delimiter: "\"" })).status).toBe(400);
  });

  it("writes a file that uploads back as an update", async () => {
    const filter = JSON.stringify({ name: { eq: "e-d" } });
    const exported = await request(http).get("/task/_csv").query({ filter, columns: "id,name" });
    const edited = exported.text.replace(",e-d", ",e-d2");
    const res = await request(http).post("/task/_csv/update").set("content-type", "text/csv").send(edited);
    expect(res.status).toBe(200);
    const after = await request(http).get("/task").query({ filter: JSON.stringify({ name: { eq: "e-d2" } }) });
    expect(after.body.rows).toHaveLength(1);
  });

  it("is documented in the OpenAPI document", () => {
    const doc = buildOpenApiDocument(orm) as { paths: Record<string, { get?: unknown }> };
    expect(doc.paths["/task/_csv"]?.get).toBeDefined();
  });
});

describe("nestize - CSV export gates", () => {
  it("is absent when CSV is off", async () => {
    const { app, http } = await start({});
    expect((await request(http).get("/task/_csv")).status).toBe(404);
    await app.close();
  });

  it("is 403 when queryCsv denies it", async () => {
    const { app, http } = await start({ csv: true }, { permission: { queryCsv: (m: string) => m !== "Task" } });
    expect((await request(http).get("/task/_csv")).status).toBe(403);
    await app.close();
  });
});
