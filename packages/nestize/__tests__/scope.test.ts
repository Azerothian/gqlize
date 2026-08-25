import type { Server } from "http";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type { Definition } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { NestizeModule } from "../src";

// nestize's list / findOne / count all reach the engine through
// `resolveFindAll`, and its writes through `processUpdate` / `processDelete` /
// `processCreate`. That is why a row-level scope needs no nestize-specific code
// — and these tests are what makes the claim checkable over HTTP, where a
// caller can name a row's id directly and the read that hides it is the only
// thing standing between them and it.

const TaskDef: Definition = {
  name: "Task",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    // Filled in by the scope, never by the client — so it has to be optional at
    // the schema level or no create would validate.
    ownerId: { type: DataTypes.STRING, allowNull: true, writable: true },
  },
  options: { timestamps: false },
};

/** The principal, as nestize can see it: off the request the service threads down. */
const owned: ScopePredicate = (_defName, _operation, _options, context) => {
  const req = (context as { req?: { headers?: {[k: string]: string | undefined} } } | undefined)?.req;
  const id = req?.headers?.["x-user"] || "";
  return { where: { ownerId: { eq: id } }, set: { ownerId: id } };
};

interface Task {
  id: number;
  name: string;
  ownerId: string | null;
}

describe("nestize - row-level scope over REST", () => {
  let app: INestApplication;
  let http: Server;
  let ours: Task;
  let alien: Task;

  const as = (user: string) => ({ "x-user": user });

  beforeAll(async () => {
    const orm = new Ormize({ permission: { scope: owned } });
    orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await orm.addDefinition(TaskDef);
    await orm.initialise();
    await orm.sync();

    const moduleRef = await Test.createTestingModule({
      imports: [NestizeModule.forRoot(orm)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    ours = (await request(http).post("/task").set(as("u1")).send({ name: "ours" })).body;
    alien = (await request(http).post("/task").set(as("u2")).send({ name: "theirs" })).body;
  });

  afterAll(async () => {
    await app.close();
  });

  it("stamps the owner on create instead of taking the client's word", async () => {
    expect(ours.ownerId).toEqual("u1");
    // `ownerId` is `writable: true`, so this is a request that tried.
    const forged = await request(http).post("/task").set(as("u1")).send({ name: "forged", ownerId: "u2" });
    expect(forged.body.ownerId).not.toEqual("u2");
  });

  it("narrows the list and its total together", async () => {
    const res = await request(http).get("/task").set(as("u2"));
    expect(res.status).toEqual(200);
    expect((res.body.rows as Task[]).map((r) => r.name)).toEqual(["theirs"]);
    expect(res.body.total).toEqual(1);
  });

  it("narrows a count-only list", async () => {
    const res = await request(http).get("/task?count=true").set(as("u2"));
    expect(res.body.total).toEqual(1);
  });

  it("404s a row the caller may not see, by id", async () => {
    // Not 403: a scoped-out row is indistinguishable from a missing one, which
    // is the whole point — a 403 would confirm it exists.
    expect((await request(http).get(`/task/${alien.id}`).set(as("u1"))).status).toEqual(404);
    expect((await request(http).get(`/task/${alien.id}`).set(as("u2"))).status).toEqual(200);
  });

  it("404s an update to a row the caller may not see", async () => {
    const res = await request(http).patch(`/task/${alien.id}`).set(as("u1")).send({ name: "stolen" });
    expect(res.status).toEqual(404);
    const after = await request(http).get(`/task/${alien.id}`).set(as("u2"));
    expect(after.body.name).toEqual("theirs");
  });

  it("404s a delete of a row the caller may not see", async () => {
    const res = await request(http).delete(`/task/${alien.id}`).set(as("u1"));
    expect(res.status).toEqual(404);
    expect((await request(http).get(`/task/${alien.id}`).set(as("u2"))).status).toEqual(200);
  });
});
