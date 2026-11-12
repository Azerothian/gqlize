import { defineConfig } from "@azerothian/gqlize/cli/types";
import { buildOrmForSchema } from "./src/orm";

/**
 * Config for the `gqlize` CLI (`gqlize build` / `check` / `print`).
 *
 * Points at the offline factory: building a schema reads model metadata and
 * never queries, and this adapter's discovery opens nothing either — so
 * `pnpm schema:check` is a CI drift gate that needs no database.
 */
export default defineConfig({
  orm: () => buildOrmForSchema(),
  out: "./generated/schema.json",
  sdl: "./generated/schema.graphql",
});
