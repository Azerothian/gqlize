import { buildArtifact } from "../../graphql/snapshot/build-artifact";
import type { ParsedArgs } from "../args";
import type { ResolvedConfig } from "../config";
import { resolveProfiles, type ResolvedProfile } from "../profiles";

/**
 * Build one artifact per selected profile.
 *
 * The orm is built once and reused across profiles: profiles differ only in
 * `options` (permission, mostly), and re-syncing a database per profile would
 * be slow and, for a seeded fixture, wrong.
 */
export default async function build(
  resolved: ResolvedConfig,
  args: ParsedArgs,
  out: (line: string) => void,
): Promise<number> {
  const profiles = resolveProfiles(resolved, args);
  const orm = await resolved.config.orm();

  for (const profile of profiles) {
    await buildOne(resolved, profile, orm, out);
  }
  return 0;
}

async function buildOne(
  resolved: ResolvedConfig,
  profile: ResolvedProfile,
  orm: any,
  out: (line: string) => void,
) {
  const result = await buildArtifact(orm, {
    out: profile.out,
    sdl: profile.sdl,
    pretty: profile.pretty,
    scalars: resolved.config.scalars,
    permissionProfile: profile.permissionProfile,
    idProfile: profile.idProfile,
    cursorProfile: profile.cursorProfile,
    options: profile.options,
  });

  const label = profile.name ? `${profile.name}: ` : "";
  out(
    `${label}${result.out} — ${result.typeCount} types, ` +
      `${result.fieldCount} fields, ${formatBytes(result.bytes)}${result.gzip ? " (gzip)" : ""}`,
  );

  if (result.sdl) {
    out(`${label}${result.sdl.path} — SDL sidecar, ${formatBytes(result.sdl.bytes)}`);
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
