import { describe, it, expect, afterEach } from "@jest/globals";
import { MikroORM, EntitySchema } from "@mikro-orm/sqlite";
import { printSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import MikroAdapter from "../src/index";

/**
 * Places this adapter is required to agree with the shipped SQL one.
 *
 * The valkey/sequelize parity suite drives its definitions in through
 * `define()`, which this adapter deliberately does not accept — it binds to the
 * entities of the instance it was given, and inventing one would mean writing
 * into a MikroORM instance that belongs to the caller. So the same *outcomes*
 * are asserted here from the two declaration forms that produce them, which is
 * what a caller actually cares about: the same model, however it was declared,
 * has to reach GraphQL the same way.
 */

class Ticket {
  id!: number;
  status!: string;
  title!: string;
  views!: number;
  live!: boolean;
}

const TicketSchema = new EntitySchema<Ticket>({
  class: Ticket,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    status: { enum: true, items: ["in-progress", "2xl", "done"] },
    title: { type: "string" },
    views: { type: "number" },
    live: { type: "boolean" },
  },
});

/** The same model as a sequelize definition, spelled with the portable tokens. */
const ticketDefinition = {
  name: "Ticket",
  define: {
    status: { type: DataTypes.Enum("in-progress", "2xl", "done"), allowNull: false },
    title: { type: String, allowNull: false },
    views: { type: Number, allowNull: false },
    live: { type: Boolean, allowNull: false },
  },
  options: { timestamps: false },
};

type EnumLike = { name: string; getValues(): { name: string; value: unknown }[] };
type MapperAdapter = { getTypeMapper(): (t: unknown, model?: string, field?: string) => unknown };

describe("parity with the SQL adapter", () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function mikroOrm() {
    const mikro = await MikroORM.init({ entities: [TicketSchema], dbName: ":memory:", allowGlobalContext: true });
    close = () => mikro.close(true);
    const adapter = new MikroAdapter(mikro, { manageSchema: true });
    const db = new Ormize().registerAdapter(adapter, "db");
    await db.initialise();
    return { db, adapter };
  }

  async function sequelizeOrm() {
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite", logging: false });
    const db = new Ormize().registerAdapter(adapter, "db");
    await db.addDefinition(ticketDefinition);
    await db.initialise();
    await db.sync();
    return { db, adapter };
  }

  const backends = [
    { name: "mikro-orm", make: mikroOrm },
    { name: "sequelize", make: sequelizeOrm },
  ];

  describe.each(backends)("$name", ({ make }) => {
    it("names an enum type and sanitises members that are not legal GraphQL names", async () => {
      const { db, adapter } = await make();
      const mapper = (adapter as unknown as MapperAdapter).getTypeMapper();
      const fields = db.getModelAdapter("Ticket").getFields("Ticket");
      const enumType = mapper(fields.status.type, "Ticket", "status") as EnumLike;

      expect(enumType.name).toBe("TicketStatusEnum");
      expect(enumType.getValues().map((v) => v.name)).toEqual(["inProgress", "_2xl", "done"]);
      // The authored member still reaches the backend unchanged.
      expect(enumType.getValues().map((v) => v.value)).toEqual(["in-progress", "2xl", "done"]);
    });

    it("classifies the three primitive columns the same way", async () => {
      const { db } = await make();
      const fields = db.getModelAdapter("Ticket").getFields("Ticket");
      const mapDataType = db.getModelAdapter("Ticket").mapDataType.bind(db.getModelAdapter("Ticket"));
      // One adapter reads a Sequelize DataType and the other a MikroORM property;
      // both have to land on the same abstract descriptor, which is what every
      // consumer downstream of `mapDataType` reasons about.
      expect(mapDataType(fields.title.type).type).toBe("String");
      expect(mapDataType(fields.views.type).type).toBe("Int");
      expect(mapDataType(fields.live.type).type).toBe("Boolean");
    });

    it("produces the same GraphQL output type", async () => {
      const { db } = await make();
      const sdl = printSchema(await createSchema(db));
      const type = sdl.slice(sdl.indexOf("type Ticket implements Node"));
      const body = type.slice(0, type.indexOf("}"));
      expect(body).toMatch(/id: ID!/);
      expect(body).toMatch(/status: TicketStatusEnum!/);
      expect(body).toMatch(/title: String!/);
      expect(body).toMatch(/views: Int!/);
      expect(body).toMatch(/live: Boolean!/);
    });

    it("agrees on the primary key and on which fields carry a global id", async () => {
      const { db } = await make();
      const adapter = db.getModelAdapter("Ticket");
      expect(adapter.getPrimaryKeyNameForModel("Ticket")).toEqual(["id"]);
      // What gqlize mints relay ids for, and the type each one belongs to.
      expect(db.getGlobalKeys("Ticket")).toEqual(["id"]);
      expect(db.getGlobalKeyTargets("Ticket")).toEqual({ id: "Ticket" });
    });
  });
});
