import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { MikroORM } from "@mikro-orm/sqlite";
import { printSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import MikroAdapter from "../src/index";
import { schemas } from "./helper/entities";

/**
 * A schema built with no database behind it.
 *
 * MikroORM runs its own entity discovery at construction and opens nothing, so
 * every definition this adapter derives comes out of metadata — which is what
 * makes `initialise({ddl: false})` enough here, exactly as it is for the SQL
 * adapter (`4dca174`).
 *
 * The tripwire is the point: the ORM is pointed at a database that cannot exist,
 * and a connection attempt throws a message the assertions look for. Asserting
 * "it worked" would pass just as well against a live connection.
 */
const TRIPWIRE = "TRIPWIRE: the offline schema build opened a connection";

describe("building a schema with no database behind it", () => {
  let mikro: MikroORM;

  beforeEach(() => {
    // The synchronous constructor discovers entities and does not connect;
    // `MikroORM.init()` would connect before handing the instance over.
    mikro = new MikroORM({
      entities: schemas,
      dbName: "/nonexistent/no-such-directory/no-such.db",
      allowGlobalContext: true,
    });
    const connection = mikro.em.getConnection();
    connection.connect = () => { throw new Error(TRIPWIRE); };
    connection.execute = () => { throw new Error(TRIPWIRE); };
  });
  afterEach(async () => { await mikro.close(true).catch(() => undefined); });

  async function build() {
    const db = new Ormize().registerAdapter(new MikroAdapter(mikro));
    await db.initialise({ ddl: false });
    return db;
  }

  it("arms the tripwire it relies on", () => {
    expect(() => mikro.em.getConnection().execute("select 1")).toThrow(TRIPWIRE);
  });

  it("discovers every entity without opening a connection", async () => {
    const db = await build();
    expect(Object.keys(db.getDefinitions()).sort()).toEqual(["Article", "Author", "Tag"]);
  });

  it("prints a full schema", async () => {
    const sdl = printSchema(await createSchema(await build()));
    expect(sdl).toContain("type Article implements Node");
    expect(sdl).toContain("enum ArticleStatusEnum");
    expect(sdl).toContain("input GQLTQueryArticleWhere ");
    // Relationships and the synthesized foreign key are wired in memory too.
    expect(sdl).toMatch(/authorId: ID/);
    expect(sdl).toMatch(/articles\(/);
  });

  it("issues no DDL even when the adapter was told it may", async () => {
    // `ddl: false` is the offline path and wins over `manageSchema`: the flag is
    // the caller saying "build, do not touch the database".
    const db = new Ormize().registerAdapter(new MikroAdapter(mikro, { manageSchema: true }));
    await expect(db.initialise({ ddl: false })).resolves.toBeUndefined();
  });
});
