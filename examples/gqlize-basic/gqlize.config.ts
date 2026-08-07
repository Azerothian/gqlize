import { defineConfig } from "@azerothian/gqlize/cli/types";
import { buildOrm } from "./src/orm";

/**
 * Config for the `gqlize` CLI (`gqlize build` / `check` / `print`).
 *
 * `orm` must return an ormize instance that is already `initialise()`d and
 * `sync()`ed — the CLI never does that for you, because how the database is
 * reached is the application's business, not the schema generator's.
 */
export default defineConfig({
  orm: () => buildOrm(),
  out: "./generated/schema.json",
  // Secondary artifact: for codegen and CI diffs. It is *not* loadable —
  // printSchema discards enum internal values, which the JSON artifact carries.
  sdl: "./generated/schema.graphql",
});
