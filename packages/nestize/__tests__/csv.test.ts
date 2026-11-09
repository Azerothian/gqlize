// `POST /:resource/_csv/:operation` (issue #81): a `text/csv` body applied as
// one write per row, all-or-nothing, under the same gates as the JSON routes.
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

type TaskRow = { id: number; name: string; done: boolean; itemId: number | null };

async function start(ormOptions: GqlizeOptions, nestizeOptions?: NestizeOptions) {
  const orm = await buildOrm(ormOptions);
  const moduleRef = await Test.createTestingModule({
    imports: [NestizeModule.forRoot(orm, nestizeOptions)],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return { orm, app, http: app.getHttpServer() };
}

function postCsv(http: Server, path: string, body: string) {
  return request(http).post(path).set("content-type", "text/csv").send(body);
}

async function tasks(http: Server): Promise<TaskRow[]> {
  const res = await request(http).get("/task");
  return (res.body.rows as TaskRow[]).sort((a, b) => a.name.localeCompare(b.name));
}

describe("nestize - CSV uploads", () => {
  let app: INestApplication<Server>;
  let http: Server;
  let orm: Ormize;

  beforeAll(async () => {
    ({ app, http, orm } = await start({ csv: { maxRows: 5 } }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates one row per line, converting cells by column type", async () => {
    const item = await request(http).post("/item").send({ label: "box" });
    const res = await postCsv(http, "/task/_csv/create", `name,done,itemId\ncsv-a,true,${item.body.id}\ncsv-b,0,\\N\n`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: TaskRow) => r.name)).toEqual(["csv-a", "csv-b"]);
    const rows = (await tasks(http)).filter((r) => r.name.startsWith("csv-"));
    expect(rows).toEqual([
      expect.objectContaining({ name: "csv-a", done: true, itemId: item.body.id }),
      expect.objectContaining({ name: "csv-b", done: false, itemId: null }),
    ]);
  });

  it("updates on the primary key, or on ?keys=", async () => {
    const created = await postCsv(http, "/task/_csv/create", "name\nupd-a\nupd-b\n");
    const [a] = created.body.rows as TaskRow[];
    expect((await postCsv(http, "/task/_csv/update", `id,done\n${a.id},true\n`)).status).toBe(200);
    expect((await postCsv(http, "/task/_csv/update?keys=name", "name,done\nupd-b,yes\n")).status).toBe(200);
    expect((await tasks(http)).filter((r) => r.name.startsWith("upd-")).map((r) => r.done)).toEqual([true, true]);
  });

  it("deletes on the primary key", async () => {
    const created = await postCsv(http, "/task/_csv/create", "name\ndel-a\ndel-b\n");
    const ids = (created.body.rows as TaskRow[]).map((r) => r.id);
    const res = await postCsv(http, "/task/_csv/delete", `id\n${ids.join("\n")}\n`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect((await tasks(http)).filter((r) => r.name.startsWith("del-"))).toEqual([]);
  });

  it("refuses a bad row with its row and column, writing nothing", async () => {
    const res = await postCsv(http, "/task/_csv/create", "name,done\nbad-a,true\nbad-b,maybe\n");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "CSV_ROW_INVALID", row: 2, column: "done" });
    expect((await tasks(http)).filter((r) => r.name.startsWith("bad-"))).toEqual([]);
  });

  it("refuses the primary key on a create", async () => {
    const res = await postCsv(http, "/task/_csv/create", "id,name\n999,forged\n");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "CSV_HEADER", column: "id" });
  });

  it("answers 413 over the row limit", async () => {
    const res = await postCsv(http, "/task/_csv/create", "name\n1\n2\n3\n4\n5\n6\n");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("CSV_TOO_MANY_ROWS");
  });

  it("404s an unknown operation", async () => {
    expect((await postCsv(http, "/task/_csv/restore", "id\n1\n")).status).toBe(404);
  });

  it("is documented in the OpenAPI document", () => {
    const doc = buildOpenApiDocument(orm);
    expect(doc.paths["/task/_csv/{operation}"]).toBeDefined();
  });
});

describe("nestize - CSV uploads, gated", () => {
  it("404s when the instance has CSV off, and leaves it out of the document", async () => {
    const { app, http, orm } = await start({});
    try {
      expect((await postCsv(http, "/task/_csv/create", "name\nx\n")).status).toBe(404);
      expect(buildOpenApiDocument(orm).paths["/task/_csv/{operation}"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("403s when `mutationCsv` or the operation is denied", async () => {
    const permission = {
      mutationCsv: (defName: string) => defName !== "Item",
      mutationDelete: () => false,
    };
    const { app, http } = await start({ csv: true }, { permission });
    try {
      expect((await postCsv(http, "/item/_csv/create", "label\nx\n")).status).toBe(403);
      expect((await postCsv(http, "/task/_csv/delete", "id\n1\n")).status).toBe(403);
      expect((await postCsv(http, "/task/_csv/create", "name\nallowed\n")).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
