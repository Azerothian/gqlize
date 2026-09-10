import Sequelize from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "../src";
import { describe, expect, it } from "@jest/globals";

/**
 * `initialise()` is the one lifecycle step that is *nearly* free of I/O:
 * `sequelize.define` and the association calls are pure metadata, and the only
 * query it ever issues is the raw create DDL a definition registered through
 * `queries`. `initialise({ddl: false})` turns that off, which is what lets a
 * schema be generated with no database behind it — see the guide's "Building
 * without a database".
 *
 * These tests pin both halves: the flag must actually suppress the query, and
 * the default must still run it, or every definition using `queries` boots
 * against a database missing the types it declared.
 */

const ENUM_DDL = "CREATE TABLE IF NOT EXISTS ddl_witness (id INTEGER PRIMARY KEY);";

const WitnessDef = {
  name: "Witness",
  define: {
    name: { type: Sequelize.STRING },
  },
  queries: {
    witness: {
      create: ENUM_DDL,
      drop: "DROP TABLE IF EXISTS ddl_witness;",
    },
  },
};

/**
 * Record every statement the adapter sends. Sequelize's `logging` callback is
 * the one place that sees *every* query including a raw one, which is what the
 * startup DDL is — so an empty `queries` here means nothing was sent at all,
 * not merely that no model was touched.
 */
function buildWithSpy() {
  const queries: string[] = [];
  const adapter = new SequelizeAdapter({}, {
    dialect: "sqlite",
    logging: (sql: string) => { queries.push(sql); },
  } as never);
  const db = new Ormize().registerAdapter(adapter);
  return { db, queries };
}

describe("initialise({ddl: false})", () => {
  it("does not replay a definition's raw DDL", async () => {
    const { db, queries } = buildWithSpy();
    await db.addDefinition(WitnessDef);

    await db.initialise({ ddl: false });

    expect(queries).toEqual([]);
  });

  it("still wires the model up, so a schema can be built from it", async () => {
    const { db } = buildWithSpy();
    await db.addDefinition(WitnessDef);
    await db.addDefinition({
      name: "Sibling",
      define: { label: { type: Sequelize.STRING } },
      relationships: [{
        type: "belongsTo",
        model: "Witness",
        name: "witness",
        options: { foreignKey: "witnessId" },
      }],
    });

    await db.initialise({ ddl: false });

    expect(Object.keys(db.getFields("Witness"))).toContain("name");
    expect(Object.keys(db.getAssociations("Sibling"))).toContain("witness");
  });

  it("replays the DDL by default", async () => {
    const { db, queries } = buildWithSpy();
    await db.addDefinition(WitnessDef);

    await db.initialise();

    expect(queries.some((sql) => sql.includes("ddl_witness"))).toBe(true);
  });

  it("issues nothing either way for a definition with no raw DDL", async () => {
    const { db, queries } = buildWithSpy();
    await db.addDefinition({ name: "Plain", define: { name: { type: Sequelize.STRING } } });

    await db.initialise();

    expect(queries).toEqual([]);
  });
});
