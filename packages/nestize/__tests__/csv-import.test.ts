// `POST /_csv`: several CSV files in one multipart body, each a create or an
// update on its own resource, applied as one unit, rows linked across files by
// `@ref` labels written into foreign-key columns.
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NestizeModule, buildOpenApiDocument } from "../src";
import type { NestizeOptions } from "../src";
import { readCsvParts } from "../src/csv-multipart";
import type { GqlizeOptions } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import { buildOrm } from "./helper";

type TaskRow = { id: number; name: string; done: boolean; itemId: number | null };
type ItemRow = { id: number; label: string };

async function start(ormOptions: GqlizeOptions, nestizeOptions?: NestizeOptions) {
  const orm = await buildOrm(ormOptions);
  const moduleRef = await Test.createTestingModule({
    imports: [NestizeModule.forRoot(orm, nestizeOptions)],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return { orm, app, http: app.getHttpServer() };
}

/** A multipart POST to `/_csv`: `[field, csv]` file parts, then text fields. */
function postImport(http: Server, files: [string, string][], fields: { [name: string]: string } = {}) {
  let req = request(http).post("/_csv");
  for (const [name, value] of Object.entries(fields)) {
    req = req.field(name, value);
  }
  for (const [field, csv] of files) {
    req = req.attach(field, Buffer.from(csv), `${field}.csv`);
  }
  return req;
}

async function rows<T>(http: Server, resource: string): Promise<T[]> {
  return (await request(http).get(`/${resource}`)).body.rows as T[];
}

describe("nestize - multi-file CSV import", () => {
  let app: INestApplication<Server>;
  let http: Server;
  let orm: Ormize;

  beforeAll(async () => {
    ({ app, http, orm } = await start({ csv: { maxRows: 10, maxFiles: 3 } }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("links rows across files through a foreign-key reference, writing the referenced file first", async () => {
    const res = await postImport(http, [
      ["task.create", "name,itemId.@ref\nimp-a,box\nimp-b,crate\n"],
      ["item", "@ref,label\nbox,imp-box\ncrate,imp-crate\n"],
    ]);
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: { name: string; resource: string; rows: unknown[] }) => [f.name, f.resource, f.rows.length]))
      .toEqual([["task.create", "task", 2], ["item", "item", 2]]);
    const items = (await rows<ItemRow>(http, "item")).filter((i) => i.label.startsWith("imp-"));
    expect(res.body.refs).toEqual({
      box: items.find((i) => i.label === "imp-box")?.id,
      crate: items.find((i) => i.label === "imp-crate")?.id,
    });
    const tasks = (await rows<TaskRow>(http, "task")).filter((t) => t.name.startsWith("imp-"));
    expect(tasks.map((t) => [t.name, t.itemId]).sort()).toEqual([
      ["imp-a", res.body.refs.box],
      ["imp-b", res.body.refs.crate],
    ]);
  });

  it("updates matched on `<field>.keys`, a labelled update row feeding a later file", async () => {
    await postImport(http, [["task.create", "name\nupd-imp\n"]]);
    const res = await postImport(
      http,
      [
        ["item.update", "@ref,label,where.label\nre,upd-renamed,imp-box\n"],
        ["task.update", "name,itemId.@ref\nupd-imp,re\n"],
      ],
      { "task.update.keys": "name" },
    );
    expect(res.status).toBe(200);
    const task = (await rows<TaskRow>(http, "task")).find((t) => t.name === "upd-imp");
    expect(task?.itemId).toBe(res.body.refs.re);
    expect((await rows<ItemRow>(http, "item")).find((i) => i.id === res.body.refs.re)?.label).toBe("upd-renamed");
  });

  it("refuses an unknown label with its file, row and column, writing nothing", async () => {
    const res = await postImport(http, [
      ["item", "@ref,label\nok,never-written\n"],
      ["task", "name,itemId.@ref\nnope,missing\n"],
    ]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "CSV_ROW_INVALID", file: "task", row: 1, column: "itemId.@ref" });
    expect((await rows<ItemRow>(http, "item")).some((i) => i.label === "never-written")).toBe(false);
  });

  it("refuses a relationship reference, which REST has no nested input for", async () => {
    const res = await postImport(http, [["item", "@ref,label\nx,y\n"], ["task", "name,item.@ref\nz,x\n"]]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "CSV_HEADER", file: "task", column: "item.@ref" });
  });

  it("refuses a part that names no resource or operation it can take", async () => {
    expect((await postImport(http, [["nothing.create", "a\nb\n"]])).body).toMatchObject({ code: "CSV_UNSUPPORTED", file: "nothing.create" });
    expect((await postImport(http, [["task.delete", "id\n1\n"]])).body).toMatchObject({ code: "CSV_UNSUPPORTED", file: "task.delete" });
  });

  it("answers 413 over the file limit, and 400 for a body that is not multipart", async () => {
    const many = await postImport(http, [["item", "label\na\n"], ["item.create", "label\nb\n"], ["task", "name\nc\n"], ["task.create", "name\nd\n"]]);
    expect(many.status).toBe(413);
    expect(many.body.code).toBe("CSV_TOO_MANY_FILES");
    const plain = await request(http).post("/_csv").set("content-type", "text/csv").send("label\na\n");
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe("CSV_UNSUPPORTED");
  });

  it("is documented in the OpenAPI document", () => {
    expect(buildOpenApiDocument(orm).paths["/_csv"]).toBeDefined();
  });
});

describe("nestize - multi-file CSV import, gated", () => {
  it("404s when the instance has CSV off", async () => {
    const { app, http, orm } = await start({});
    try {
      expect((await postImport(http, [["item", "label\nx\n"]])).status).toBe(404);
      expect(buildOpenApiDocument(orm).paths["/_csv"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("403s a file whose resource or operation the caller may not use, writing nothing", async () => {
    const permission = { mutationCsv: (defName: string) => defName !== "Task" };
    const { app, http } = await start({ csv: true }, { permission });
    try {
      const res = await postImport(http, [["item", "@ref,label\ng,gated\n"], ["task", "name,itemId.@ref\nt,g\n"]]);
      expect(res.status).toBe(403);
      expect((await rows<ItemRow>(http, "item")).some((i) => i.label === "gated")).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("readCsvParts", () => {
  it("takes files a multer interceptor already read, under the limits", async () => {
    const req = { files: [{ fieldname: "item", buffer: Buffer.from("label\nx\n") }], body: { "item.delimiter": ";" } };
    expect(await readCsvParts(req, { maxFiles: 2, maxBytes: () => 100 })).toEqual({
      files: [{ field: "item", data: Buffer.from("label\nx\n") }],
      fields: { "item.delimiter": ";" },
    });
    await expect(readCsvParts(req, { maxFiles: 2, maxBytes: () => 3 })).rejects.toMatchObject({ code: "CSV_TOO_LARGE", file: "item" });
    await expect(readCsvParts(req, { maxFiles: 0, maxBytes: () => 100 })).rejects.toMatchObject({ code: "CSV_TOO_MANY_FILES" });
  });
});
