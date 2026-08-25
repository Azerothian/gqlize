import { beforeEach, describe, expect, it } from "@jest/globals";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type { Definition } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { createActivities } from "../src/activities";
import type { ActivityMap } from "../src/types";

// Every read activity is meant to be a caller of `resolveFindAll`, and every
// write a caller of `processUpdate` / `processDelete` / `processCreate` — which
// is the entire reason a row-level scope needs no temporalize-specific code.
// These tests are the proof of that claim rather than a test of the scope
// itself: if an activity ever grows its own path to the adapter, one of them
// stops passing.

const TaskDef: Definition = {
  name: "Task",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    // `allowNull` because the *client* never supplies this — the scope does,
    // after input validation. A column the scope fills in but the schema marks
    // required is a create no caller can make.
    ownerId: { type: DataTypes.STRING, allowNull: true, writable: true },
  },
  options: { timestamps: false },
};

interface Task {
  id: number;
  name: string;
  ownerId: string | null;
}

const owned: ScopePredicate = (_defName, _operation, _options, context) => {
  const id = (context as { userId?: string } | undefined)?.userId;
  return { where: { ownerId: { eq: id } }, set: { ownerId: id } };
};

async function buildOrm(): Promise<Ormize> {
  const orm = new Ormize({ permission: { scope: owned } });
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}

const mine = { userId: "u1" };
const theirs = { userId: "u2" };

describe("temporalize - row-level scope funnels through the engine", () => {
  let acts: ActivityMap;
  let ours: Task;
  let alien: Task;

  /** `ActivityMap` answers `unknown` by design; only these tests know the shape. */
  const call = <T>(name: string, req: unknown) => acts[name](req) as Promise<T>;

  beforeEach(async () => {
    const orm = await buildOrm();
    acts = createActivities(orm);
    [ours] = await call<Task[]>("Task.create", { context: mine, input: { name: "ours" } });
    [alien] = await call<Task[]>("Task.create", { context: theirs, input: { name: "theirs" } });
  });

  it("forces the owning field on create rather than trusting the input", () => {
    // `ownerId` is `writable: true` here, so the client *could* send one. It
    // did not, and the scope supplied it anyway.
    expect(ours.ownerId).toEqual("u1");
    expect(alien.ownerId).toEqual("u2");
  });

  it("narrows findAll and its total together", async () => {
    const list = await call<{rows: Task[]; total: number}>("Task.findAll", { context: mine });
    expect(list.rows.map((r) => r.name)).toEqual(["ours"]);
    expect(list.total).toEqual(1);
  });

  it("narrows findOne", async () => {
    const one = await call<Task>("Task.findOne", { context: theirs });
    expect(one.name).toEqual("theirs");
  });

  it("narrows count", async () => {
    expect(await call<number>("Task.count", { context: mine })).toEqual(1);
  });

  it("returns null from findByPk for a row the caller may not see", async () => {
    // The load-bearing one. `findByPk` is a `where` on the primary key handed to
    // `resolveFindAll`, *not* a raw pk read — and it has to stay that way. An
    // optimisation to `adapter.findById` would look like a pure speed-up and
    // would quietly restore the oldest IDOR there is.
    expect(await call<Task | null>("Task.findByPk", { context: mine, id: alien.id })).toBeNull();
    expect((await call<Task>("Task.findByPk", { context: mine, id: ours.id })).name).toEqual("ours");
  });

  it("will not update a row the caller cannot see", async () => {
    const updated = await call<Task[]>("Task.update", {
      context: mine, input: { name: "stolen" }, where: { id: { eq: alien.id } },
    });
    expect(updated).toEqual([]);
    expect((await call<Task>("Task.findByPk", { context: theirs, id: alien.id })).name).toEqual("theirs");
  });

  it("will not delete a row the caller cannot see", async () => {
    await call<unknown>("Task.destroy", { context: mine, where: { id: { eq: alien.id } } });
    expect(await call<Task | null>("Task.findByPk", { context: theirs, id: alien.id })).not.toBeNull();
  });

  it("will not select a row the caller cannot see", async () => {
    const selected = await call<Task[]>("Task.select", { context: mine, where: { id: { eq: alien.id } } });
    expect(selected).toEqual([]);
  });
});
