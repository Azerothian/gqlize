/**
 * The package version, as a value the runtime can read.
 *
 * Deliberately hand-written rather than `require("../package.json")`: the build
 * emits `cjs/` and `esm/` trees whose relative path to the manifest differs, and
 * a JSON import would leak the whole manifest into consumer bundles. Kept honest
 * by `__tests__/version.test.ts`, which fails the build if it drifts from
 * `package.json#version` — a lying version would silently weaken the artifact
 * fingerprint's staleness check.
 *
 * The release workflow rewrites the line below alongside every `package.json`
 * (`.github/workflows/release.yml`, "Set package versions"), so keep it on one
 * line in exactly this shape — the workflow throws if its regex stops matching.
 */
export const VERSION = "6.0.0";

export default VERSION;
