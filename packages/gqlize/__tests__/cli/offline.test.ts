import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it, expect, beforeAll, beforeEach, afterEach} from "@jest/globals";

import {offlineInstance} from "../helper/offline";
import {run} from "../../src/cli/run";

// Same trick as run.test.ts: the config module is imported natively and so
// cannot resolve the workspace packages from a temp directory, but it does
// share `globalThis`.
declare global {
  // `var` rather than `let`/`const`: only `var` declares a property on `globalThis`.
  var __GQLIZE_CLI_OFFLINE_ORM__: Awaited<ReturnType<typeof offlineInstance>> | undefined;
}

/**
 * The CLI, end to end, against an instance that cannot reach a database.
 *
 * `gqlize build` / `print` / `check` are the surface a CI schema-drift gate
 * runs, and a gate is only worth having if it does not need a database service
 * to run in. The orm here arms a `beforeConnect` tripwire (see
 * `helper/offline.ts`), so any command that opens a connection fails loudly
 * rather than passing on a machine that happens to have a server running.
 *
 * `check` is the interesting one: it defaults to `--strict`, which rebuilds the
 * schema live and diffs the sorted SDL against the artifact, so this covers the
 * build path twice over.
 */
describe("gqlize CLI, with no database", () => {
  let root: string;
  let out: string[];
  let err: string[];

  const io = () => ({out: (l: string) => out.push(l), err: (l: string) => err.push(l)});
  const stdout = () => out.join("\n");
  const stderr = () => err.join("\n");

  beforeAll(async() => {
    globalThis.__GQLIZE_CLI_OFFLINE_ORM__ = await offlineInstance();
  });

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), "gqlize-cli-offline-"));
    out = [];
    err = [];
  });

  afterEach(async() => {
    await rm(root, {recursive: true, force: true});
  });

  async function config() {
    const path = join(root, "gqlize.config.cjs");
    await writeFile(
      path,
      "module.exports = {orm: () => globalThis.__GQLIZE_CLI_OFFLINE_ORM__, " +
        `out: ${JSON.stringify(join(root, "schema.json"))}, ` +
        `sdl: ${JSON.stringify(join(root, "schema.graphql"))}};`,
    );
    return path;
  }

  it("prints the schema", async() => {
    expect(await run(["print", "-c", await config()], io())).toEqual(0);
    expect(stderr()).toEqual("");
    expect(stdout()).toContain("type Author");
  });

  it("builds an artifact and its SDL sidecar", async() => {
    expect(await run(["build", "-c", await config()], io())).toEqual(0);
    expect(stderr()).toEqual("");
    expect(stdout()).toContain("schema.json");
    expect(stdout()).toContain("schema.graphql");
  });

  it("checks a fresh artifact clean, live rebuild and all", async() => {
    const path = await config();
    expect(await run(["build", "-c", path], io())).toEqual(0);

    out = [];
    err = [];
    expect(await run(["check", "-c", path], io())).toEqual(0);
    expect(stderr()).toEqual("");
    expect(stdout()).toContain("ok");
  });
});
