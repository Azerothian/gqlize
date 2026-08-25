import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphql } from "graphql";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";

import { createInstance, resultData, validateResult } from "../helper";
import type { CursorCodec, IdCodec } from "../../src";
import { createSchema, prefixIdCodec, plainCursorCodec } from "../../src";
import { loadSchema } from "../../src/snapshot";
import { run } from "../../src/cli/run";

type Instance = Awaited<ReturnType<typeof createInstance>>;

/** the shape {@link SOURCE} selects */
type ChildEdges = {models: {Child: {edges: {cursor: string; node: {id: string; name: string}}[]}}};

/** the handles the config file reaches for */
const testGlobals = globalThis as typeof globalThis & {
  __GQLIZE_CLI_TEST_ORM__?: Instance;
  __GQLIZE_CLI_TEST_CODECS__?: {id: IdCodec; cursor: CursorCodec};
};

/**
 * `gqlize build` -> `loadSchema` with codecs, end to end.
 *
 * The config file is imported natively from a temp directory and cannot resolve
 * the workspace packages, so the codecs reach it through `globalThis` — the same
 * trick `cli/run.test.ts` uses for the orm.
 */
describe("gqlize CLI with codecs", () => {
  let root: string;
  let out: string[];
  let err: string[];
  let instance: Instance;

  const io = () => ({out: (l: string) => out.push(l), err: (l: string) => err.push(l)});
  const stderr = () => err.join("\n");

  const id = prefixIdCodec({
    prefixes: {Task: "TSK", TaskItem: "TSKI", Item: "ITM", Parent: "PAR", Child: "CHD"},
    pad: 6,
  });
  const cursor = plainCursorCodec();

  beforeAll(async() => {
    instance = await createInstance();
    testGlobals.__GQLIZE_CLI_TEST_ORM__ = instance;
    testGlobals.__GQLIZE_CLI_TEST_CODECS__ = {id, cursor};
    for (let i = 1; i <= 3; i++) {
      await instance.models.Child.create({name: `c${i}`});
    }
  });

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), "gqlize-codec-cli-"));
    out = [];
    err = [];
  });

  afterEach(async() => {
    await rm(root, {recursive: true, force: true});
  });

  async function config(body = "", name = "gqlize.config.cjs") {
    const path = join(root, name);
    await writeFile(
      path,
      `module.exports = {orm: () => globalThis.__GQLIZE_CLI_TEST_ORM__${body}};`,
    );
    return path;
  }

  const WITH_CODECS =
    ", options: globalThis.__GQLIZE_CLI_TEST_CODECS__, idProfile: 'prefix', cursorProfile: 'plain'";

  const SOURCE =
    `query { models { Child(first: 2, orderBy: nameASC) { edges { cursor node { id name } } } } }`;

  it("builds an artifact whose loaded schema mints the same ids and cursors", async() => {
    const path = await config(WITH_CODECS);
    expect(await run(["build", "-c", path], io())).toEqual(0);

    const file = join(root, "gqlize.schema.json");
    const loaded = await loadSchema(file, instance, {
      id, cursor, idProfile: "prefix", cursorProfile: "plain",
    });

    const live = await graphql({schema: await createSchema(instance, {id, cursor}), source: SOURCE});
    const fromArtifact = await graphql({schema: loaded, source: SOURCE});
    validateResult(live);
    validateResult(fromArtifact);
    expect(fromArtifact.data).toEqual(live.data);
    const edges = resultData<ChildEdges>(fromArtifact).models.Child.edges;
    expect(edges[0].node.id).toMatch(/^CHD0*1$/);
    expect(edges[1].cursor)
      .toEqual(cursor.encode({
        connection: cursor.decode({value: edges[1].cursor})!.connection,
        index: 1,
      }));

    // the profiles made it into the artifact on the way through
    const written = JSON.parse(await readFile(file, "utf8")) as {fingerprint: unknown};
    expect(written.fingerprint).toMatchObject({idProfile: "prefix", cursorProfile: "plain"});
  });

  it("passes `check` against the config that built it", async() => {
    const path = await config(WITH_CODECS);
    await run(["build", "-c", path], io());
    expect(await run(["check", "-c", path], io())).toEqual(0);
  });

  // The point of the fingerprint buckets: an artifact built with codecs and
  // served without them resolves perfectly well, in the wrong format.
  it("fails `check` when the serving config dropped the codecs", async() => {
    const built = await config(WITH_CODECS, "with-codecs.config.cjs");
    const served = await config("", "no-codecs.config.cjs");
    await run(["build", "-c", built, "-o", join(root, "schema.json")], io());

    err = [];
    expect(await run(["check", "-c", served, "--artifact", join(root, "schema.json")], io())).toEqual(1);
    expect(stderr()).toContain("optionsShape");
  });

  it("fails `check` when only the profile moved", async() => {
    const built = await config(WITH_CODECS, "v1.config.cjs");
    const served = await config(
      ", options: globalThis.__GQLIZE_CLI_TEST_CODECS__, idProfile: 'prefix-v2', cursorProfile: 'plain'",
      "v2.config.cjs",
    );
    await run(["build", "-c", built, "-o", join(root, "schema.json")], io());

    err = [];
    expect(await run(["check", "-c", served, "--artifact", join(root, "schema.json")], io())).toEqual(1);
    expect(stderr()).toContain("idProfile");
  });
});
