/**
 * belongsToMany `through` over REST. The relationship and `select` routes hand
 * their body to the engine as-is, so the permission checks GraphQL gets from
 * its typed input are made by the service: a join model hidden by
 * `permission.model` takes no `through`, and each column must pass the join
 * model's `mutationCreateInput`. A generated join model is no resource at all.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import type { Permission } from "@azerothian/utilize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";
import { NestizeModule } from "../src";

async function buildOrm(): Promise<Ormize> {
  const orm = new Ormize();
  const adapter = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(adapter, { suite: true });
  orm.registerAdapter(adapter, testDialect());
  const through = { model: "PostTag" };
  await orm.addDefinition({ name: "Post", define: { title: { type: DataTypes.STRING } }, options: { timestamps: false },
    relationships: [{ type: "belongsToMany", model: "Tag", name: "tags", options: { through, foreignKey: "postId", otherKey: "tagId" } }] });
  await orm.addDefinition({ name: "Tag", define: { name: { type: DataTypes.STRING } }, options: { timestamps: false },
    relationships: [{ type: "belongsToMany", model: "Post", name: "posts", options: { through, foreignKey: "tagId", otherKey: "postId" } }] });
  await orm.addDefinition({ name: "PostTag", define: { sortOrder: { type: DataTypes.INTEGER }, label: { type: DataTypes.STRING } }, options: { timestamps: false } });
  // What ormize registers for a cross-adapter belongsToMany with no join model.
  await orm.addDefinition({ name: "Hidden", define: { x: { type: DataTypes.INTEGER } }, options: { timestamps: false }, generated: true });
  await orm.initialise();
  await orm.sync();
  return orm;
}

async function boot(permission?: Permission) {
  const orm = await buildOrm();
  const moduleRef = await Test.createTestingModule({
    imports: [NestizeModule.forRoot(orm, permission ? { permission } : {})],
  }).compile();
  const app: INestApplication<Server> = moduleRef.createNestApplication();
  await app.init();
  const http = app.getHttpServer();
  const post = (await request(http).post("/post").send({ title: "p1" })).body as { id: number };
  await request(http).post("/tag").send({ name: "t1" });
  return { app, http, orm, postId: post.id };
}

const joinRows = async (orm: Ormize) => await orm.getModelAdapter("PostTag").findAll("PostTag", {}) as Record<string, unknown>[];
const value = (row: Record<string, unknown>, key: string) =>
  typeof (row as { get?: unknown }).get === "function" ? (row as unknown as { get: (k: string) => unknown }).get(key) : row[key];

describe("nestize - belongsToMany through", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({ mutationCreateInput: (model: string, field: string) => !(model === "PostTag" && field === "label") });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("writes a permitted join column", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`)
      .send({ add: [{ where: { name: { eq: "t1" } }, through: { sortOrder: 7 } }] });
    expect(res.status).toBeLessThan(300);
    const rows = await joinRows(ctx.orm);
    expect(rows.map((r) => value(r, "sortOrder"))).toEqual([7]);
  });

  it("refuses a join column mutationCreateInput denies", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`)
      .send({ add: [{ where: { name: { eq: "t1" } }, through: { label: "x" } }] });
    expect(res.status).toBe(403);
  });

  it("refuses a join key", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`)
      .send({ set: [{ where: { name: { eq: "t1" } }, through: { postId: 999 } }] });
    expect(res.status).toBe(403);
  });

  it("checks through nested in a select input", async () => {
    const res = await request(ctx.http).post("/post/select")
      .send({ where: { title: { eq: "p1" } }, input: { tags: { add: [{ where: { name: { eq: "t1" } }, through: { label: "x" } }] } } });
    expect(res.status).toBe(403);
  });

  it("refuses a bare filter, as the engine does on every route", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`).send({ add: [{ name: { eq: "t1" } }] });
    expect(res.status).toBe(403);
  });

  it("holds the where of a { where, through } entry to the filter allow-list", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`)
      .send({ add: [{ where: { name: { col: "name" } }, through: { sortOrder: 1 } }] });
    expect(res.status).toBe(400);
  });

  it("holds a relationship read's filter to the operator allow-list", async () => {
    const res = await request(ctx.http).get(`/post/${ctx.postId}/tags`)
      .query({ filter: JSON.stringify({ name: { col: "name" } }) });
    expect(res.status).toBe(400);
  });

  it("does not expose a generated join model", async () => {
    expect((await request(ctx.http).get("/hidden")).status).toBe(404);
  });
});

describe("nestize - belongsToMany with a hidden join model", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({ model: (model: string) => model !== "PostTag" });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("refuses through", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`)
      .send({ add: [{ where: { name: { eq: "t1" } }, through: { sortOrder: 1 } }] });
    expect(res.status).toBe(403);
  });

  it("refuses a { where } wrapper", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`).send({ set: [{ where: { name: { eq: "t1" } } }] });
    expect(res.status).toBe(403);
  });

  it("holds a bare filter to the filter allow-list", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`).send({ add: [{ name: { col: "name" } }] });
    expect(res.status).toBe(400);
  });

  it("links with a bare filter", async () => {
    const res = await request(ctx.http).post(`/post/${ctx.postId}/tags`).send({ add: [{ name: { eq: "t1" } }] });
    expect(res.status).toBeLessThan(300);
    expect(await joinRows(ctx.orm)).toHaveLength(1);
  });
});
