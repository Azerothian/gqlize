import { defineConfig } from "../../src/cli/types";
import { createInstance } from "./index";

/**
 * CLI config for the test fixture, so `pnpm print-schema` (and any ad-hoc
 * `gqlize build`/`check` against the fixture) goes through the real CLI rather
 * than a bespoke script.
 */
export default defineConfig({
  orm: () => createInstance(),
  out: "./fixture.schema.json",
});
