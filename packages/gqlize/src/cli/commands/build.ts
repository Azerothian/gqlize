import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { printSchema } from "graphql";

import { createSchema } from "../../index";
import { snapshotSchema } from "../../graphql/snapshot/snapshot";
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
  const schema = await createSchema(orm, profile.options);
  const artifact = snapshotSchema(schema, {
    scalars: resolved.config.scalars,
    permissionProfile: profile.permissionProfile,
  });

  const json = JSON.stringify(artifact, null, profile.pretty ? 2 : undefined);
  const gzip = profile.out.endsWith(".gz");
  const bytes = await writeAtomic(profile.out, gzip ? gzipSync(json) : Buffer.from(json, "utf8"));

  const label = profile.name ? `${profile.name}: ` : "";
  out(
    `${label}${profile.out} — ${artifact.types.length} types, ` +
      `${countFields(artifact)} fields, ${formatBytes(bytes)}${gzip ? " (gzip)" : ""}`,
  );

  if (profile.sdl) {
    const sdlBytes = await writeAtomic(profile.sdl, Buffer.from(printSchema(schema), "utf8"));
    out(`${label}${profile.sdl} — SDL sidecar, ${formatBytes(sdlBytes)}`);
  }
}

/**
 * Write via a sibling temp file plus `rename`.
 *
 * `rename` is atomic within a filesystem, so a reader (a running server, a CI
 * diff) never observes a half-written artifact, and a crash mid-write leaves
 * the previous good artifact in place rather than a truncated one.
 */
async function writeAtomic(path: string, data: Buffer): Promise<number> {
  await mkdir(dirname(path), {recursive: true});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
  return data.byteLength;
}

function countFields(artifact: any): number {
  return artifact.types.reduce(
    (total: number, type: any) => total + (type.fields?.length || type.values?.length || 0),
    0,
  );
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
