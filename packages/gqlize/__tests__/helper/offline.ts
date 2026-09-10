import Sequelize from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

import type { Definition } from "../../src/types";

/**
 * An ormize instance that is deliberately impossible to query.
 *
 * Building a GraphQL schema reads model metadata — attributes, associations,
 * `paranoid` — and never opens a connection, which is what lets `gqlize build`
 * run in a CI job with no database service. That is a property worth *proving*
 * rather than asserting, so the adapter here names a postgres server that does
 * not exist and arms a `beforeConnect` tripwire: any attempt to reach it throws
 * immediately, naming itself, instead of hanging until the TCP connect times
 * out (which is what a bare dead port does — around two minutes).
 *
 * The definitions carry the shapes that would most plausibly need a database if
 * anything did: a relationship, a soft-deleting model, and raw create/drop DDL
 * in `queries`. The last is the reason `initialise` is passed `{ddl: false}` —
 * without it, `initialise()` replays that DDL against a server.
 */
export const TRIPWIRE_MESSAGE = "offline test: the schema build opened a connection";

export const offlineDefinitions: Definition[] = [
  {
    name: "Author",
    define: {
      name: {type: Sequelize.STRING, allowNull: false},
    },
    relationships: [{
      type: "hasMany",
      model: "Book",
      name: "books",
      options: {as: "books", foreignKey: "authorId"},
    }],
    // Raw DDL: the one thing `initialise()` would otherwise send to a server.
    queries: {
      genre: {
        create: "CREATE TYPE genre AS ENUM ('fiction', 'history');",
        drop: "DROP TYPE IF EXISTS genre;",
      },
    },
  } as Definition,
  {
    name: "Book",
    options: {paranoid: true},
    define: {
      title: {type: Sequelize.STRING, allowNull: false},
      pages: {type: Sequelize.INTEGER},
    },
    relationships: [{
      type: "belongsTo",
      model: "Author",
      name: "author",
      options: {foreignKey: "authorId"},
    }],
  },
];

export async function offlineInstance() {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "postgres",
    host: "127.0.0.1",
    port: 1,
    database: "no-such-database",
    logging: false,
    hooks: {
      beforeConnect() {
        throw new Error(TRIPWIRE_MESSAGE);
      },
    },
  } as never), "offline");

  for (const definition of offlineDefinitions) {
    await db.addDefinition(definition);
  }
  await db.initialise({ddl: false});
  return db;
}

/**
 * Try to reach the database the offline instance names, so a test can prove the
 * tripwire is armed — without which "no connection was opened" is unfalsifiable.
 */
export async function probeConnection(db: Awaited<ReturnType<typeof offlineInstance>>) {
  const adapter = db.adapters.offline as unknown as SequelizeAdapter;
  return adapter.getORM().query("SELECT 1");
}

/**
 * The same definitions against in-memory sqlite, connected and migrated — the
 * "production" side of the offline-build story. `initialise()` here runs the
 * `queries` DDL, which is why this one needs a database and the offline one
 * does not. Sqlite has no `CREATE TYPE`, so the enum is declared per-dialect at
 * the call site rather than in the shared definitions.
 */
export async function liveInstance() {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "offline");

  for (const definition of offlineDefinitions) {
    // sqlite cannot run the postgres `CREATE TYPE`; drop it for this backend.
    const {queries: _dropped, ...rest} = definition as Definition & {queries?: unknown};
    await db.addDefinition(rest);
  }
  await db.initialise();
  await db.sync();
  return db;
}
