import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { UsageError } from "./args";
import type { GqlizeConfig } from "./types";

const CONFIG_NAMES = [
  "gqlize.config.ts",
  "gqlize.config.mts",
  "gqlize.config.mjs",
  "gqlize.config.js",
  "gqlize.config.cjs",
];

export interface ResolvedConfig {
  config: GqlizeConfig;
  /** absolute path the config came from, for error messages */
  path: string;
  /** directory relative `out`/`sdl` paths resolve against */
  dir: string;
}

/**
 * Find and load the config.
 *
 * Order: `--config`, then the nearest `gqlize.config.*` walking up from the cwd,
 * then `package.json#gqlize`. Walking up matters in a monorepo, where commands
 * are commonly run from a package directory but the config sits at the root.
 */
export async function loadConfig(explicitPath?: string, cwd = process.cwd()): Promise<ResolvedConfig> {
  const path = explicitPath
    ? resolve(cwd, explicitPath)
    : await findConfig(cwd);
  if (!path) {
    throw new UsageError(
      `no gqlize config found. Looked for ${CONFIG_NAMES.join(", ")} in ${cwd} and its parents, ` +
        "and for a `gqlize` key in package.json. Pass --config <path>.",
    );
  }
  if (explicitPath && !(await exists(path))) {
    throw new UsageError(`config file not found: ${path}`);
  }
  const modulePath = path.endsWith("package.json") ? await pointerTarget(path) : path;
  const config = normalise(await importConfig(modulePath), modulePath);

  if (typeof config?.orm !== "function") {
    throw new UsageError(
      `${modulePath} must export a config whose \`orm\` is a function returning an initialised, ` +
        "synced ormize instance.",
    );
  }
  return {config, path: modulePath, dir: dirname(modulePath)};
}

/**
 * Resolve `package.json#gqlize` to the config module it points at.
 *
 * The key is a *pointer*, not the config itself: `orm` has to be a function, so
 * the config can never live in JSON. Accepts `"gqlize": "./gqlize.config.ts"` or
 * `"gqlize": {"config": "./gqlize.config.ts"}`.
 */
async function pointerTarget(packageJsonPath: string): Promise<string> {
  const pointer = JSON.parse(await readFile(packageJsonPath, "utf8")).gqlize;
  const target = typeof pointer === "string" ? pointer : pointer?.config;
  if (typeof target !== "string") {
    throw new UsageError(
      `${packageJsonPath}#gqlize must be a path to a config module (or {"config": "<path>"}). ` +
        "The config itself cannot live in package.json because `orm` is a function.",
    );
  }
  return resolve(dirname(packageJsonPath), target);
}

async function findConfig(cwd: string): Promise<string | undefined> {
  const {root} = parsePath(resolve(cwd));
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (await exists(candidate)) {
        return candidate;
      }
    }
    const pkg = join(dir, "package.json");
    if (await exists(pkg)) {
      try {
        if (JSON.parse(await readFile(pkg, "utf8")).gqlize) {
          return pkg;
        }
      } catch {
        // an unreadable package.json is not this command's problem
      }
    }
    if (dir === root) {
      return undefined;
    }
    dir = dirname(dir);
  }
}

/**
 * Import the config module.
 *
 * Three attempts, in decreasing order of how much they know about the host:
 *
 *  1. `require`, for anything not explicitly ESM. This goes through whatever
 *     loader hook the process already installed (`@swc-node/register`,
 *     `ts-node`, `tsx`), and that hook is the only thing that can honour a
 *     config's `tsconfig` `paths` and extensionless relative imports.
 *  2. native `import` — Node 24 strips TypeScript types on its own, so a
 *     self-contained `.ts` config needs nothing installed at all.
 *  3. re-exec once through the application's `tsx`, guarded by an env flag so a
 *     failure there cannot loop.
 */
async function importConfig(path: string): Promise<any> {
  // `.mjs`/`.mts` are unambiguously ESM; skip straight to `import`
  if (!/\.m[jt]s$/.test(path)) {
    try {
      const {createRequire} = await import("node:module");
      return createRequire(join(dirname(path), "noop.js"))(path);
    } catch {
      // no loader hook, or the file is ESM — fall through to `import`
    }
  }
  try {
    return await import(pathToFileURL(path).href);
  } catch (err: any) {
    if (isTypeScriptLoadFailure(err) && !process.env.GQLIZE_CLI_REEXEC) {
      await reexecThroughTsx(path);
    }
    throw new Error(`gqlize: failed to load config ${path}: ${err.message}`, {cause: err});
  }
}

/**
 * Did `import()` fail *because* the config is TypeScript, rather than because
 * the config is broken? Only the former is worth re-execing through `tsx` for —
 * exported so the classification is pinned by tests, since getting it wrong
 * either loses a real error or re-execs on one.
 */
export function isTypeScriptLoadFailure(err: any) {
  return err?.code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    err?.code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING" ||
    /Unknown file extension|type stripping|Unsupported/i.test(err?.message || "");
}

async function reexecThroughTsx(configPath: string): Promise<void> {
  const {createRequire} = await import("node:module");
  // resolve from the config's own directory, not gqlize's — tsx is the
  // *application's* dev dependency. `createRequire` rather than `import.meta`
  // or a bare `require`, so this behaves the same in the cjs and esm builds.
  const req = createRequire(join(dirname(configPath), "noop.js"));
  let tsx: string;
  try {
    tsx = req.resolve("tsx/cli");
  } catch {
    // no tsx available — fall back to the original error, which names the file
    return;
  }
  const {spawnSync} = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [tsx, ...process.argv.slice(1)],
    {stdio: "inherit", env: {...process.env, GQLIZE_CLI_REEXEC: "1"}},
  );
  process.exit(result.status ?? 1);
}

/**
 * Accept `export default config`, `module.exports = config`, or `export const config`.
 *
 * Take the first candidate that actually looks like a config before falling back
 * to the positional chain: transpiler/bundler interop routinely hangs a
 * synthetic `default` off the namespace object, so "has an `orm` function" is a
 * far more reliable signal than "is called `default`".
 */
function normalise(mod: any, path: string): GqlizeConfig {
  const candidates = [mod?.default?.default, mod?.default, mod?.config, mod];
  const looksLikeConfig = candidates.find(
    (candidate) => candidate && typeof candidate === "object" && typeof candidate.orm === "function",
  );
  const candidate = looksLikeConfig ?? candidates.find((c) => c !== undefined);
  if (!candidate || typeof candidate !== "object") {
    throw new UsageError(`${path} did not export a config object`);
  }
  return candidate as GqlizeConfig;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a config-relative path; absolute paths and `undefined` pass through. */
export function resolveOut(dir: string, path?: string) {
  if (!path) {
    return undefined;
  }
  return isAbsolute(path) ? path : resolve(dir, path);
}

/**
 * Point a reader at the artifact that `build` actually wrote.
 *
 * `--gzip` is a *build* flag, and it makes `build` append `.gz` to `out` (see
 * `resolveProfiles`). Nobody passes it to `check` or `print`, so a plain
 * `gqlize build --gzip && gqlize check` would otherwise look for the
 * uncompressed name and call a perfectly good artifact missing. Fall back to the
 * `.gz` sibling only when the requested path does not exist, so a genuinely
 * absent artifact is still reported under the name the operator asked for.
 *
 * Nothing downstream cares which one it gets: `readSnapshot` detects gzip by
 * magic bytes, not by extension.
 */
export async function resolveArtifactPath(path: string): Promise<string> {
  if (path.endsWith(".gz") || await exists(path)) {
    return path;
  }
  return (await exists(`${path}.gz`)) ? `${path}.gz` : path;
}
