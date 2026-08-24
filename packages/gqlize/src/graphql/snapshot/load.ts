import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { GraphQLSchema } from "graphql";

import type { GqlizeOptions } from "../../types";
import type { SchemaSnapshot } from "./ir";
import { materializeSchema, type MaterializeOptions } from "./materialize";

const gunzipAsync = promisify(gunzip);

/**
 * Read a schema artifact from disk and materialize it against a live ormize
 * instance.
 *
 * Convenience only — `materializeSchema` is the real entry point, and is what to
 * call when the artifact arrives from a bundler import, object storage, or a
 * config service rather than the filesystem.
 *
 * `.gz` files are decompressed. Detection is by magic bytes rather than by
 * extension, so an artifact renamed in a deploy pipeline still loads.
 */
export async function loadSchema(
  artifactPath: string,
  orm: any,
  options: GqlizeOptions & MaterializeOptions = {},
): Promise<GraphQLSchema> {
  return materializeSchema(await readSnapshot(artifactPath), orm, options);
}

/** Read + decompress + parse an artifact, without materializing it. */
export async function readSnapshot(artifactPath: string): Promise<SchemaSnapshot> {
  let buffer: Buffer;
  try {
    buffer = await readFile(artifactPath);
  } catch (err: any) {
    throw new Error(
      `gqlize: could not read schema artifact "${artifactPath}": ${err.message}`,
      {cause: err},
    );
  }
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = (await gunzipAsync(buffer));
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (err: any) {
    throw new Error(
      `gqlize: schema artifact "${artifactPath}" is not valid JSON: ${err.message}`,
      {cause: err},
    );
  }
}
