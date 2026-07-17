import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";

/** Contexts observed by the Order `before` hook — proof the request context is
 *  readable inside hooks without being threaded through the call. */
export const seenContexts: any[] = [];

/**
 * One ormize instance, TWO adapters:
 *   - "sqlite" — in-memory SQLite, hosts the `Order` model.
 *   - "pg"     — Postgres (PGlite over a unix socket), hosts the `Payment` model.
 *
 * A single `orm.transaction(...)` spanning both is coordinated: commit both or
 * roll back both.
 */
export async function buildOrm(pgDir: string): Promise<any> {
  const orm: any = new Ormize();

  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  orm.registerAdapter(
    new SequelizeAdapter({}, {
      dialect: "postgres",
      host: pgDir, // the unix-socket directory
      port: 5432,
      username: "postgres",
      password: "postgres",
      database: "postgres",
      logging: false,
      pool: { max: 1, min: 0, idle: 1000 },
    }),
    "pg",
  );

  // Order → SQLite adapter (3rd arg binds the definition to a named adapter).
  await orm.addDefinition(
    {
      name: "Order",
      define: { ref: { type: Sequelize.STRING, allowNull: false } },
      options: { timestamps: false },
      before(opts: any) {
        // Read the ambient request context — it was never passed in here.
        seenContexts.push(orm.getContext());
        return opts.params;
      },
    },
    "sqlite",
  );

  // Payment → Postgres adapter. `amount` is NOT NULL, so we can force a DB-level
  // failure on the Postgres side to demonstrate the cross-adapter rollback.
  await orm.addDefinition(
    {
      name: "Payment",
      define: {
        orderRef: { type: Sequelize.STRING, allowNull: false },
        amount: { type: Sequelize.INTEGER, allowNull: false },
      },
      options: { timestamps: false },
    },
    "pg",
  );

  await orm.initialise();
  await orm.sync();
  return orm;
}
