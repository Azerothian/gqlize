import { basename, dirname, extname, join } from "node:path";

import type { ParsedArgs } from "./args";
import { UsageError } from "./args";
import { resolveOut, type ResolvedConfig } from "./config";
import type { GqlizeOptions } from "../types";

export interface ResolvedProfile {
  /** the profile's name, or `undefined` for the config's own top-level profile */
  name?: string;
  options: GqlizeOptions;
  permissionProfile?: string;
  out: string;
  sdl?: string;
  pretty: boolean;
}

const DEFAULT_OUT = "./gqlize.schema.json";

/**
 * Work out which profiles this invocation covers, and where each one writes.
 *
 * A named profile inherits the top-level `out` with its name folded into the
 * filename (`schema.json` -> `schema.admin.json`) unless it sets its own. That
 * rule is what makes `--all-profiles` safe: without it, two profiles would
 * silently overwrite one file, and the second would win.
 */
export function resolveProfiles(resolved: ResolvedConfig, args: ParsedArgs): ResolvedProfile[] {
  const {config} = resolved;
  const names = Object.keys(config.profiles || {});

  if (args.allProfiles) {
    if (names.length === 0) {
      throw new UsageError("--all-profiles was given but the config declares no `profiles`");
    }
    return names.map((name) => build(resolved, args, name));
  }
  if (args.profile) {
    if (!config.profiles?.[args.profile]) {
      throw new UsageError(
        `unknown profile "${args.profile}"` +
          (names.length ? ` (config declares ${names.join(", ")})` : " (config declares none)"),
      );
    }
    return [build(resolved, args, args.profile)];
  }
  return [build(resolved, args)];
}

function build(resolved: ResolvedConfig, args: ParsedArgs, name?: string): ResolvedProfile {
  const {config, dir} = resolved;
  const profile = name ? config.profiles![name] : config;
  const baseOut = resolveOut(dir, config.out) || resolveOut(dir, DEFAULT_OUT)!;

  // A single-profile invocation may be redirected by --out/--sdl; under
  // --all-profiles those flags would collapse every profile onto one file, so
  // they are ignored there and each profile keeps its own destination.
  const single = !args.allProfiles;
  const out = (single && resolveOut(dir, args.out)) ||
    resolveOut(dir, profile.out) ||
    (name ? withSuffix(baseOut, name) : baseOut);
  const sdl = (single && resolveOut(dir, args.sdl)) ||
    resolveOut(dir, profile.sdl) ||
    (name && config.sdl ? withSuffix(resolveOut(dir, config.sdl)!, name) : resolveOut(dir, config.sdl));

  return {
    name,
    options: profile.options || config.options || {},
    permissionProfile:
      args.permissionProfile ?? profile.permissionProfile ?? config.permissionProfile ?? name,
    out: args.gzip && !out.endsWith(".gz") ? `${out}.gz` : out,
    sdl,
    pretty: args.pretty ?? profile.pretty ?? config.pretty ?? false,
  };
}

/** `./generated/schema.json` + `admin` -> `./generated/schema.admin.json` */
function withSuffix(path: string, suffix: string) {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${suffix}${ext}`);
}
