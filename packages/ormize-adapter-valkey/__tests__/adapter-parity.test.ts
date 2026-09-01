import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import { relationshipAccessors } from "@azerothian/utilize/utils/relationship-accessors";
import type { Definition } from "@azerothian/utilize/types/index";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

/**
 * Places the two shipped adapters are required to agree, and once did not.
 *
 * Each case here is a definition that a caller could reasonably write and expect
 * to be portable. The value of running them against BOTH backends is the whole
 * point — a single-adapter test would have passed throughout the period these
 * were broken.
 */

let client: IORedis;
beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });

const backends = [
  { name: "sequelize", make: () => new SequelizeAdapter({}, { dialect: "sqlite", logging: false }) },
  { name: "valkey", make: () => new ValkeyAdapter({ prefix: "parity" }, client) },
];

/**
 * `getTypeMapper` is implemented by both adapters but is not on the published
 * `OrmAdapter` contract, so it is reached off the concrete adapter rather than
 * through `orm.getModelAdapter()`.
 */
type TypeMapping = { name: string; getValues(): { name: string; value: unknown }[] };
type MapperAdapter = { getTypeMapper(): (t: unknown, model?: string, field?: string) => unknown };

describe.each(backends)("$name adapter — parity", ({ name, make }) => {
  let orm: Ormize;
  let adapter: ReturnType<typeof make>;
  beforeEach(async () => {
    if (name === "valkey") await flush(client);
    orm = new Ormize();
    adapter = make();
    orm.registerAdapter(adapter, "db");
  });

  it("builds an enum whose members are not legal GraphQL names", async () => {
    // `in-progress` and `2xl` are not legal GraphQL enum value names. The valkey
    // adapter used each member verbatim, so `new GraphQLEnumType` threw here and
    // the whole schema build failed.
    const def: Definition = {
      name: "Ticket",
      define: { status: { type: DataTypes.Enum("in-progress", "2xl", "done") } },
      options: {},
    };
    await orm.addDefinition(def);
    await orm.initialise();

    const mapper = (adapter as unknown as MapperAdapter).getTypeMapper();
    const fields = orm.getModelAdapter("Ticket").getFields("Ticket");
    const enumType = mapper(fields.status.type, "Ticket", "status") as TypeMapping;

    expect(enumType.name).toBe("TicketStatusEnum");
    expect(enumType.getValues().map((v) => v.name)).toEqual(["inProgress", "_2xl", "done"]);
    // The authored member still reaches the backend unchanged.
    expect(enumType.getValues().map((v) => v.value)).toEqual(["in-progress", "2xl", "done"]);
  });

  it("accepts a bare JS constructor as a field type", async () => {
    // `field: String` was portable on valkey and produced a broken model on
    // sequelize, where the constructor reached `sequelize.define` untouched.
    const def = {
      name: "Note",
      define: { title: { type: String }, views: { type: Number }, live: { type: Boolean } },
      options: {},
    } as unknown as Definition;
    await orm.addDefinition(def);
    await orm.initialise();
    await orm.sync();

    const row = await orm.models.Note.create({ title: "hello", views: 3, live: true });
    expect(row).toBeDefined();

    const fields = orm.getModelAdapter("Note").getFields("Note");
    expect(fields.title).toBeDefined();
    expect(fields.views).toBeDefined();
    expect(fields.live).toBeDefined();
  });
});

describe("valkey — accessor names come from the shared table", () => {
  beforeEach(async () => { await flush(client); });

  it("defines exactly the names relationshipAccessors reports", async () => {
    // `getAssociations` reports accessor names from `relationshipAccessors`;
    // `tag()` used to derive them a second, independent way. They agreed by
    // coincidence, and nothing enforced it — a drift would have made a
    // cross-adapter relationship look up an accessor that was never defined.
    const orm = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "acc" }, client), "db");
    await orm.addDefinition({
      name: "Author",
      define: { name: { type: DataTypes.String } },
      options: {},
      relationships: [{ type: "hasMany", model: "Post", name: "posts", options: { foreignKey: "authorId" } }],
    });
    await orm.addDefinition({
      name: "Post",
      define: { title: { type: DataTypes.String } },
      options: {},
      relationships: [{ type: "belongsTo", model: "Author", name: "author", options: { foreignKey: "authorId" } }],
    });
    await orm.initialise();
    await orm.sync();

    const author = await orm.models.Author.create({ name: "a" }) as unknown as Record<string, unknown>;
    const acc = relationshipAccessors("posts");
    for (const key of ["get", "set", "add", "addMultiple", "remove", "removeMultiple", "count", "hasSingle", "hasAll"] as const) {
      expect(typeof author[acc[key]]).toBe("function");
    }
  });
});
