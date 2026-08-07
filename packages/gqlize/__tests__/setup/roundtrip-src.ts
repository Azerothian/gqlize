import {createSchema as buildSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";

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
export async function createSchema(orm: any, options?: any) {
  const live = await buildSchema(orm, options);
  const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
  return materializeSchema(artifact, orm, options);
}
