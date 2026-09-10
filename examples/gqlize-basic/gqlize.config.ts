import { defineConfig } from "@azerothian/gqlize/cli/types";
import { buildOrmForSchema } from "./src/orm";

/**
 * Config for the `gqlize` CLI (`gqlize build` / `check` / `print`).
 *
 * `orm` must return an ormize instance that is already `initialise()`d — the CLI
 * never does that for you, because how the database is reached is the
 * application's business, not the schema generator's.
 *
 * It does *not* have to be `sync()`ed, and it does not have to be connected to
 * anything: building a schema reads model metadata and never queries. That is
 * why this points at `buildOrmForSchema` rather than the server's `buildOrm` —
 * `pnpm schema:check` then runs as a CI drift gate with no database at all.
 */
export default defineConfig({
  orm: () => buildOrmForSchema(),
  out: "./generated/schema.json",
  // Secondary artifact: for codegen and CI diffs. It is *not* loadable —
  // printSchema discards enum internal values, which the JSON artifact carries.
  sdl: "./generated/schema.graphql",
});
