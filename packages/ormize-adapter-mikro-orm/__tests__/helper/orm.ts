import { MikroORM } from "@mikro-orm/sqlite";
import { Ormize } from "@azerothian/ormize";
import MikroAdapter, { type MikroAdapterOptions } from "../../src/index";
import { schemas } from "./entities";

/** A fresh in-memory MikroORM instance with the test entities discovered. */
export async function makeMikro() {
  return MikroORM.init({ entities: schemas, dbName: ":memory:", debug: false, allowGlobalContext: true });
}

/**
 * A fresh ormize bound to a fresh MikroORM.
 *
 * `manageSchema` is what lets `initialise()` create the tables; without it the
 * adapter issues no DDL at all, which is the default because the instance it is
 * handed belongs to the caller.
 */
export async function makeOrm(options: MikroAdapterOptions = {}) {
  const mikro = await makeMikro();
  const adapter = new MikroAdapter(mikro, { manageSchema: true, ...options });
  const db = new Ormize().registerAdapter(adapter);
  await db.initialise();
  return { db, mikro, adapter };
}
