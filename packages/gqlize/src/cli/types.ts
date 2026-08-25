import type { GraphQLScalarType } from "graphql";

import type { GqlizeOptions } from "../types";

/**
 * A build profile — one artifact, built with one set of options.
 *
 * Profiles exist because `options.permission` reshapes the schema: an `admin`
 * and an `anon` build of the same definitions are different artifacts, and a
 * server that serves both wants both files.
 */
export interface GqlizeProfile {
  /** the options handed to `createSchema` for this profile */
  options?: GqlizeOptions;
  /**
   * Opaque id recorded in the artifact's fingerprint, and the only handle the
   * staleness check has on `options.permission` (predicates are closures and
   * cannot be hashed). Defaults to the profile's own name.
   */
  permissionProfile?: string;
  /**
   * The same stand-in for `options.id` / `options.cursor`. Unlike
   * `permissionProfile` these do **not** default to the profile name: two
   * profiles that differ only in permissions share one id format, and naming
   * them apart would report drift where there is none.
   */
  idProfile?: string;
  cursorProfile?: string;
  /** artifact path; defaults to the top-level `out` with the profile name folded in */
  out?: string;
  /** optional SDL sidecar for codegen / CI diffs */
  sdl?: string;
  /** pretty-print the artifact JSON (default false); `--pretty` / `--no-pretty` override */
  pretty?: boolean;
}

export interface GqlizeConfig extends GqlizeProfile {
  /**
   * Returns an **initialised and synced** ormize instance. Called once per CLI
   * invocation. The CLI never calls `initialise()`/`sync()` itself — connection
   * details, migrations and seeding are the application's business.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the consumer's own ormize instance, generic over the model map their `define()` chain accumulated. This is the published shape of a `gqlize.config.ts`; pinning it to `AnyOrmize` would change what a 6.0.0 config file is allowed to return. The CLI forwards the value to `createSchema`, which is where the type is actually required.
  orm: () => any | Promise<any>;
  /** default artifact path; `./gqlize.schema.json` when omitted */
  out?: string;
  /** custom scalars, by name. The loader must be given the same map. */
  scalars?: Record<string, GraphQLScalarType>;
  /** named profiles; `--profile <name>` / `--all-profiles` select them */
  profiles?: Record<string, GqlizeProfile>;
}

/**
 * Identity function that exists purely for the types — it gives editors
 * completion and type-checking inside `gqlize.config.ts` without the author
 * having to write an explicit annotation.
 */
export function defineConfig(config: GqlizeConfig): GqlizeConfig {
  return config;
}

export default defineConfig;
