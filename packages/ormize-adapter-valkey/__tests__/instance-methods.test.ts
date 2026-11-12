import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { Definition } from "@azerothian/utilize/types/index";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

type Row = { [key: string]: unknown };

async function build(defs: Definition[]) {
  const orm = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix: "imethods" }, client), "valkey");
  for (const def of defs) {
    await orm.addDefinition(def);
  }
  await orm.initialise();
  await orm.sync();
  return orm;
}

const note = (instanceMethods: Definition["instanceMethods"]): Definition => ({
  name: "Note",
  define: { title: { type: DataTypes.String, index: true } },
  instanceMethods,
});

describe("valkey adapter — user instance methods are never silently dropped", () => {
  it("lets a user method named like a built-in replace it", async () => {
    // `tag()` attached the built-ins first and never overwrites, so this
    // `toJSON` used to be dropped without a word.
    const orm = await build([note({ toJSON(this: { title: string }) { return { custom: this.title }; } })]);
    const created = await orm.models.Note.create({ title: "n1" }) as { toJSON(): unknown };
    expect(created.toJSON()).toEqual({ custom: "n1" });
  });

  it("rejects a method named like a field", async () => {
    await expect(build([note({ title() { return "x"; } })])).rejects.toThrow(/instance method "title" has the same name as a field/);
  });

  it("rejects a method named like a relationship accessor", async () => {
    await expect(build([
      { ...note({ getTags() { return []; } }), relationships: [{ type: "hasMany", model: "Tag", name: "tags", options: { foreignKey: "noteId" } }] },
      { name: "Tag", define: { label: { type: DataTypes.String } } },
    ])).rejects.toThrow(/instance method "getTags" has the same name as relationship "tags"/);
  });
});

describe("valkey adapter — asInstance", () => {
  it("tags a copy of a plain row and leaves the original alone", async () => {
    const orm = await build([note({ shout(this: { title: string }) { return `${this.title}!`; } })]);
    const plain: Row = { id: 1, title: "n1" };
    const row = orm.asInstance("Note", plain) as Row & { shout(): string; get(key: string): unknown };
    expect(row).not.toBe(plain);
    expect(row.shout()).toBe("n1!");
    expect(row.get("title")).toBe("n1");
    expect(Object.getOwnPropertyNames(plain).sort()).toEqual(["id", "title"]);
  });

  it("returns a record it already tagged unchanged", async () => {
    const orm = await build([note({})]);
    const created = await orm.models.Note.create({ title: "n1" });
    expect(orm.asInstance("Note", created)).toBe(created);
  });
});
