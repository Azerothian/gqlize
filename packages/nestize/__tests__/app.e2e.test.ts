import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createRoleBasedPermissions } from "@azerothian/utilize";
import { NestizeModule } from "../src";
import type { Ormize } from "@azerothian/ormize";
import { buildOrm } from "./helper";

/** A single task row, as returned by the REST API. */
type TaskRow = { name: string };

describe("nestize - REST e2e", () => {
  let app: INestApplication<Server>;
  let orm: Ormize;
  let http: Server;

  beforeAll(async () => {
    orm = await buildOrm();
    const moduleRef = await Test.createTestingModule({
      imports: [NestizeModule.forRoot(orm)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /task creates a row", async () => {
    const res = await request(http).post("/task").send({ name: "alpha" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.name).toBe("alpha");
    expect(res.body.id).toBeDefined();
  });

  it("POST /task with a missing required field is 400", async () => {
    const res = await request(http).post("/task").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation failed");
  });

  it("GET /task lists rows with total", async () => {
    await request(http).post("/task").send({ name: "beta" });
    const res = await request(http).get("/task");
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe("number");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it("GET /task/:id fetches one, 404 when missing", async () => {
    const created = await request(http).post("/task").send({ name: "gamma" });
    const id = created.body.id;
    const found = await request(http).get(`/task/${id}`);
    expect(found.status).toBe(200);
    expect(found.body.name).toBe("gamma");

    const missing = await request(http).get("/task/999999");
    expect(missing.status).toBe(404);
  });

  it("PATCH /task?filter updates matching rows", async () => {
    const created = await request(http).post("/task").send({ name: "delta" });
    const id = created.body.id;
    const filter = encodeURIComponent(JSON.stringify({ id: { eq: id } }));
    const res = await request(http).patch(`/task?filter=${filter}`).send({ name: "delta2" });
    expect(res.status).toBe(200);
    const refetch = await request(http).get(`/task/${id}`);
    expect(refetch.body.name).toBe("delta2");
  });

  it("GET /item/:id/tasks returns the related tasks", async () => {
    const item = await request(http).post("/item").send({ label: "box" });
    const itemId = item.body.id;
    await request(http).post("/task").send({ name: "child", itemId });
    const res = await request(http).get(`/item/${itemId}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect((res.body.rows as TaskRow[]).some((t) => t.name === "child")).toBe(true);
  });

  it("DELETE /task?filter removes matching rows", async () => {
    const created = await request(http).post("/task").send({ name: "doomed" });
    const id = created.body.id;
    const filter = encodeURIComponent(JSON.stringify({ id: { eq: id } }));
    const res = await request(http).delete(`/task?filter=${filter}`);
    expect(res.status).toBe(200);
    const refetch = await request(http).get(`/task/${id}`);
    expect(refetch.status).toBe(404);
  });
});

describe("nestize - permission denied", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => {
    const orm = await buildOrm();
    const permission = createRoleBasedPermissions(
      "user",
      { user: { model: "allow", mutationCreate: { Task: "deny" } } },
      { defaultDeny: false }
    );
    const moduleRef = await Test.createTestingModule({
      imports: [NestizeModule.forRoot(orm, { permission })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /task is 403 when create is denied", async () => {
    const res = await request(http).post("/task").send({ name: "nope" });
    expect(res.status).toBe(403);
  });
});
