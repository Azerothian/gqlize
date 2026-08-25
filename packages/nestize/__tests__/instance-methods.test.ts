import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NestizeModule } from "../src";
import type { NestizeOptions } from "../src";
import { buildOrm } from "./helper";

/**
 * `POST /:resource/:id/_actions/:method` enumerates the *implementation*
 * namespace, which both `expose.instanceMethods` targets share. Until this
 * suite it gated everything on `queryInstanceMethods` and never persisted, so a
 * pre-commit transform was reachable under the read gate and its writes to
 * `this` were dropped on the floor. These cover the split.
 */
async function boot(options: NestizeOptions): Promise<{ app: INestApplication<Server>; http: Server }> {
  const orm = await buildOrm();
  const moduleRef = await Test.createTestingModule({
    imports: [NestizeModule.forRoot(orm, { expose: { instanceMethods: true }, ...options })],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, http: app.getHttpServer() };
}

async function makeTask(http: Server, name: string): Promise<number> {
  const created = await request(http).post("/task").send({ name });
  return created.body.id as number;
}

describe("nestize - instance methods (`_actions`)", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => { ({ app, http } = await boot({})); });
  afterAll(async () => { await app.close(); });

  it("a query-target method returns its value and writes nothing", async () => {
    const id = await makeTask(http, "alpha");
    const res = await request(http).post(`/task/${id}/_actions/describe`).send({});
    expect(res.status).toBe(201);
    // A bare string return serialises as `text/plain`, so it lands in `.text`.
    expect(res.text).toBe("task:alpha");
    const after = await request(http).get(`/task/${id}`);
    expect(after.body.name).toBe("alpha");
  });

  it("a transform's write to `this` is committed, not dropped", async () => {
    // The defect this suite exists for: the route used to call the method and
    // serialise its return value, so `this.name = ...` never reached the adapter.
    const id = await makeTask(http, "beta");
    const res = await request(http).post(`/task/${id}/_actions/appendSuffix`).send({ suffix: "-done" });
    expect(res.status).toBe(201);
    const after = await request(http).get(`/task/${id}`);
    expect(after.body.name).toBe("beta-done");
  });

  it("a transform that returns values to merge is committed too", async () => {
    const id = await makeTask(http, "gamma");
    await request(http).post(`/task/${id}/_actions/rename`).send({});
    const after = await request(http).get(`/task/${id}`);
    expect(after.body.name).toBe("renamed");
  });

  it("an empty body runs a transform with no params", async () => {
    // Invoking the route is itself the ask, unlike gqlize's `apply` input, which
    // lists every exposed transform and needs a truthy value to mean "run this".
    const id = await makeTask(http, "delta");
    await request(http).post(`/task/${id}/_actions/appendSuffix`).send();
    const after = await request(http).get(`/task/${id}`);
    expect(after.body.name).toBe("delta!");
  });

  it("a transform responds with the persisted row, not the method's return", async () => {
    const id = await makeTask(http, "epsilon");
    const res = await request(http).post(`/task/${id}/_actions/appendSuffix`).send({ suffix: "!" });
    const row = Array.isArray(res.body) ? res.body[0] : res.body;
    expect(row.name).toBe("epsilon!");
  });

  it("is 404 for an unknown id and for an unknown method", async () => {
    const id = await makeTask(http, "zeta");
    expect((await request(http).post(`/task/999999/_actions/appendSuffix`).send({})).status).toBe(404);
    expect((await request(http).post(`/task/${id}/_actions/nope`).send({})).status).toBe(404);
  });

  it("a method under neither `expose` target stays reachable and read-only", async () => {
    // The enumeration is implementation-driven, so `expose` presence is not a
    // precondition for the route. Only names in `.mutations` change lane.
    const id = await makeTask(http, "eta");
    const res = await request(http).post(`/task/${id}/_actions/undeclared`).send({});
    expect(res.status).toBe(201);
    expect(res.text).toBe("undeclared:eta");
  });
});

describe("nestize - instance methods are gated by target", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => {
    // Grants the read gate and nothing else. Before the fix this let a transform
    // through, because a transform was checked against `queryInstanceMethods`.
    ({ app, http } = await boot({
      permission: {
        queryInstanceMethods: () => true,
        mutationInstanceMethods: () => false,
      },
    }));
  });
  afterAll(async () => { await app.close(); });

  it("queryInstanceMethods alone does not admit a transform", async () => {
    const id = await makeTask(http, "theta");
    const res = await request(http).post(`/task/${id}/_actions/appendSuffix`).send({ suffix: "-x" });
    expect(res.status).toBe(403);
    const after = await request(http).get(`/task/${id}`);
    expect(after.body.name).toBe("theta");
  });

  it("the query-target method is still allowed by that same bag", async () => {
    const id = await makeTask(http, "iota");
    const res = await request(http).post(`/task/${id}/_actions/describe`).send({});
    expect(res.status).toBe(201);
    expect(res.text).toBe("task:iota");
  });
});

describe("nestize - instance methods under mutationInstanceMethods", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => {
    ({ app, http } = await boot({
      permission: {
        queryInstanceMethods: () => false,
        mutationInstanceMethods: (_defName, methodName) => methodName === "appendSuffix",
      },
    }));
  });
  afterAll(async () => { await app.close(); });

  it("admits the named transform and refuses the other", async () => {
    const id = await makeTask(http, "kappa");
    expect((await request(http).post(`/task/${id}/_actions/appendSuffix`).send({ suffix: "-ok" })).status).toBe(201);
    expect((await request(http).get(`/task/${id}`)).body.name).toBe("kappa-ok");
    expect((await request(http).post(`/task/${id}/_actions/rename`).send({})).status).toBe(403);
  });

  it("does not admit the query-target method", async () => {
    const id = await makeTask(http, "lambda");
    expect((await request(http).post(`/task/${id}/_actions/describe`).send({})).status).toBe(403);
  });
});

describe("nestize - instance-method transforms honour the model write gate", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => {
    // Grants the transform gate but denies updates outright. The transform gate
    // says *which* transforms a role may run, not that it may write at all.
    ({ app, http } = await boot({
      permission: {
        mutationInstanceMethods: () => true,
        mutationUpdate: () => false,
      },
    }));
  });
  afterAll(async () => { await app.close(); });

  it("refuses a transform when update is denied for the model", async () => {
    const id = await makeTask(http, "nu");
    expect((await request(http).post(`/task/${id}/_actions/appendSuffix`).send({})).status).toBe(403);
    expect((await request(http).get(`/task/${id}`)).body.name).toBe("nu");
  });
});

describe("nestize - readOnly", () => {
  let app: INestApplication<Server>;
  let http: Server;

  beforeAll(async () => { ({ app, http } = await boot({ readOnly: false })); });
  afterAll(async () => { await app.close(); });

  it("a read-only instance is set up separately, so a plain read is not refused here", async () => {
    // `assertWritable` now runs only on the transform branch — a query-target
    // method is a read and was being refused under `readOnly` for no reason.
    const id = await makeTask(http, "mu");
    expect((await request(http).post(`/task/${id}/_actions/describe`).send({})).status).toBe(201);
  });
});
