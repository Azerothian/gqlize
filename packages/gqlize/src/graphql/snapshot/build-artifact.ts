import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { printSchema, type GraphQLScalarType } from "graphql";

import { createSchema } from "../../index";
import type { GqlizeOptions } from "../../types";
import { snapshotSchema } from "./snapshot";

export interface BuildArtifactOptions {
  /** Artifact path. A ".gz" suffix gzips the artifact. */
  out: string;
  /** Optional SDL sidecar path, written alongside the artifact. */
  sdl?: string;
  /** Pretty-print the JSON artifact. Defaults to compact. */
  pretty?: boolean;
  scalars?: Record<string, GraphQLScalarType>;
  permissionProfile?: string;
  /** Opaque ids for the configured id / cursor codecs, folded into the fingerprint. */
  idProfile?: string;
  cursorProfile?: string;
  /** Passed through to `createSchema(orm, options)`. */
  options?: GqlizeOptions;
}

export interface BuildArtifactResult {
  out: string;
  gzip: boolean;
  bytes: number;
  typeCount: number;
  fieldCount: number;
  sdl?: { path: string; bytes: number };
}

/**
 * Build a schema from `orm` and write it to disk as a JSON artifact — the
 * same job `gqlize build` does for a single profile, exposed for callers
 * that want to generate an artifact from their own tooling instead of the
 * CLI (e.g. a monorepo build script).
 */
export async function buildArtifact(
  orm: any,
  opts: BuildArtifactOptions,
): Promise<BuildArtifactResult> {
  const schema = await createSchema(orm, opts.options);
  const artifact = snapshotSchema(schema, {
    scalars: opts.scalars,
    permissionProfile: opts.permissionProfile,
    idProfile: opts.idProfile,
    cursorProfile: opts.cursorProfile,
  });

  const json = JSON.stringify(artifact, null, opts.pretty ? 2 : undefined);
  const gzip = opts.out.endsWith(".gz");
  const bytes = await writeAtomic(opts.out, gzip ? gzipSync(json) : Buffer.from(json, "utf8"));

  const result: BuildArtifactResult = {
    out: opts.out,
    gzip,
    bytes,
    typeCount: artifact.types.length,
    fieldCount: countFields(artifact),
  };

  if (opts.sdl) {
    const sdlBytes = await writeAtomic(opts.sdl, Buffer.from(printSchema(schema), "utf8"));
    result.sdl = {path: opts.sdl, bytes: sdlBytes};
  }

  return result;
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
