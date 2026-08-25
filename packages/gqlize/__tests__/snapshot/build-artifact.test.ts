import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {printSchema} from "graphql";
import {describe, it, expect, beforeAll, afterAll} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {buildArtifact, snapshotSchema} from "../../src/snapshot";

/**
 * `buildArtifact` is the extracted core of `gqlize build` — build, snapshot,
 * write to disk — exposed so callers can generate an artifact from their own
 * tooling instead of shelling out to the CLI. These tests exercise it the way
 * the CLI command does: real bytes written to a real path, read back and
 * checked, rather than asserting against `buildOne` internals.
 */
describe("buildArtifact", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gqlize-build-artifact-"));
  });
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  it("writes a JSON artifact matching snapshotSchema's output", async() => {
    const instance = await createInstance();
    const out = join(dir, "schema.json");

    const result = await buildArtifact(instance, {out});

    expect(result).toMatchObject({out, gzip: false});
    expect(result.bytes).toBeGreaterThan(0);

    const written = JSON.parse(readFileSync(out, "utf8"));
    const expected = snapshotSchema(await createSchema(instance));
    expect(written.types.length).toEqual(expected.types.length);
    expect(result.typeCount).toEqual(expected.types.length);
    expect(result.fieldCount).toBeGreaterThan(0);
  });

  it("gzips the artifact when `out` ends in .gz", async() => {
    const instance = await createInstance();
    const out = join(dir, "schema.json.gz");

    const result = await buildArtifact(instance, {out});
    expect(result.gzip).toEqual(true);

    const raw = readFileSync(out);
    // gzip magic bytes — proves the file is actually compressed, not just named .gz
    expect(raw[0]).toEqual(0x1f);
    expect(raw[1]).toEqual(0x8b);

    const written = JSON.parse(gunzipSync(raw).toString("utf8"));
    expect(written.types.length).toEqual(result.typeCount);
  });

  it("writes an SDL sidecar when `sdl` is given", async() => {
    const instance = await createInstance();
    const out = join(dir, "schema-with-sdl.json");
    const sdl = join(dir, "schema-with-sdl.graphql");

    const result = await buildArtifact(instance, {out, sdl});

    expect(result.sdl).toMatchObject({path: sdl});
    expect(result.sdl!.bytes).toBeGreaterThan(0);

    const written = readFileSync(sdl, "utf8");
    const expected = printSchema(await createSchema(instance));
    expect(written).toEqual(expected);
  });
});
