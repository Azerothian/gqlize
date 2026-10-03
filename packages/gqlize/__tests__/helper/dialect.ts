import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {
  closeConnection,
  dialectConfig,
  registerTeardown as registerSharedTeardown,
  testDialect,
} from "@azerothian/test-fixtures/dialect";
import { GqlizeAdapter } from "../../src/types";

/**
 * gqlize's view of the shared test database (`@azerothian/test-fixtures/dialect`):
 * SQLite in memory, or Postgres through PGlite, picked by the Jest project.
 * On Postgres every adapter gets a database of its own (see `dialectConfig`).
 */

export { shutdownShared, teardownAll, teardownSuite } from "@azerothian/test-fixtures/dialect";

/** The dialect this Jest project runs on. */
export function currentDialect(): "sqlite" | "postgres" {
  return testDialect();
}

/** Run `fn` after the current test. */
export function registerTeardown(fn: () => Promise<void>) {
  registerSharedTeardown(fn);
}

/**
 * Run `fn` after the file instead: a database built once in a `beforeAll` has
 * to outlive the per-test teardown, or its connection closes after the first
 * test.
 */
export function registerSuiteTeardown(fn: () => Promise<void>) {
  registerSharedTeardown(fn, { suite: true });
}

export interface DialectAdapter {
  adapter: GqlizeAdapter;
  name: string;
  teardown: () => Promise<void>;
}

/** A Sequelize adapter on the current dialect; the caller registers `teardown`. */
export async function createAdapterForDialect(
  adapterOptions: ConstructorParameters<typeof SequelizeAdapter>[0] = {},
): Promise<DialectAdapter> {
  const sequelizeAdapter = new SequelizeAdapter(adapterOptions, await dialectConfig());
  return {
    adapter: sequelizeAdapter as unknown as GqlizeAdapter,
    name: currentDialect(),
    // Closing over the concrete adapter rather than the widened view keeps
    // `.sequelize` typed.
    teardown: () => closeConnection(sequelizeAdapter),
  };
}

/**
 * Register a dialect-aware adapter on `db`, closed after the current test (or,
 * with `suite`, after the file). The replacement for the hand-built
 * `new SequelizeAdapter({}, {dialect: "sqlite"})` a test used to register,
 * which kept it on SQLite whichever project ran it.
 */
export async function registerDialectAdapter(
  db: { registerAdapter(adapter: GqlizeAdapter, name: string): unknown },
  options: { suite?: boolean } = {},
): Promise<GqlizeAdapter> {
  const { adapter, name, teardown } = await createAdapterForDialect();
  (options.suite ? registerSuiteTeardown : registerTeardown)(teardown);
  db.registerAdapter(adapter, name);
  return adapter;
}
