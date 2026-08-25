import {createSchema as buildSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import type {Ormize} from "@azerothian/ormize";
import type {GqlizeOptions} from "../../src/types";

/**
 * Stands in for `../src` in the `roundtrip` jest project.
 *
 * Every functional suite then runs against a schema that has been through the
 * artifact — built, serialized to JSON, and materialized back — rather than the
 * live one. That is the test that makes the whole design safe: a binding that
 * fails to round-trip shows up as a real query returning the wrong data, not as
 * a diff in a printed schema.
 *
 * `JSON.parse(JSON.stringify(...))` is deliberate. Passing the live object graph
 * straight to the materializer would let object identity paper over anything the
 * IR failed to describe.
 */
// `Ormize`'s own generic defaults (`{[name: string]: any}`, `IORBase`) already
// match what `buildSchema`/`materializeSchema` expect, with no explicit `any`
// needed here.
export async function createSchema(orm: Ormize, options?: GqlizeOptions) {
  const live = await buildSchema(orm, options);
  const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
  return materializeSchema(artifact, orm, options);
}
