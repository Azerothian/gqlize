import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {UsageError} from "../../src/cli/args";
import {
  isTypeScriptLoadFailure,
  loadConfig,
  resolveArtifactPath,
  resolveOut,
} from "../../src/cli/config";

/**
 * Config discovery has to be predictable, because getting it wrong means
 * building an artifact from the wrong definitions — which the fingerprint will
 * then happily certify as fresh.
 */
describe("loadConfig", () => {
  let root: string;

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), "gqlize-config-"));
  });

  async function write(relative: string, contents: string) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), {recursive: true});
    await writeFile(path, contents);
    return path;
  }

  const CONFIG = "module.exports = {orm: () => ({tag: TAG}), out: './out.json'};";

  it("loads an explicit --config path", async() => {
    const path = await write("custom.cjs", CONFIG.replace("TAG", "'explicit'"));
    const resolved = await loadConfig(path);
    expect(resolved.path).toEqual(path);
    expect(resolved.dir).toEqual(root);
    expect((await resolved.config.orm()).tag).toEqual("explicit");
  });

  it("resolves a relative --config against the cwd", async() => {
    await write("nested/custom.cjs", CONFIG.replace("TAG", "'relative'"));
    const resolved = await loadConfig("./custom.cjs", join(root, "nested"));
    expect((await resolved.config.orm()).tag).toEqual("relative");
  });

  it("names the path when an explicit --config does not exist", async() => {
    await expect(loadConfig(join(root, "missing.cjs")))
      .rejects.toThrow(/config file not found: .*missing\.cjs/);
  });

  it("walks up from the cwd to find gqlize.config.*", async() => {
    await write("gqlize.config.cjs", CONFIG.replace("TAG", "'root'"));
    await mkdir(join(root, "a", "b"), {recursive: true});
    const resolved = await loadConfig(undefined, join(root, "a", "b"));
    expect((await resolved.config.orm()).tag).toEqual("root");
  });

  it("stops at the nearest config, not the outermost", async() => {
    await write("gqlize.config.cjs", CONFIG.replace("TAG", "'root'"));
    await write("a/gqlize.config.cjs", CONFIG.replace("TAG", "'nearer'"));
    const resolved = await loadConfig(undefined, join(root, "a", "b"));
    expect((await resolved.config.orm()).tag).toEqual("nearer");
  });

  it("prefers gqlize.config.mjs over gqlize.config.cjs in the same directory", async() => {
    await write("gqlize.config.mjs", "export default {orm: () => ({tag: 'mjs'})};");
    await write("gqlize.config.cjs", CONFIG.replace("TAG", "'cjs'"));
    const resolved = await loadConfig(undefined, root);
    expect((await resolved.config.orm()).tag).toEqual("mjs");
  });

  /**
   * `gqlize.config.ts` is the form the README, the example and `defineConfig`
   * all document, so it is the one that most needs proving. It loads through
   * the `createRequire` branch — the same path a `@swc-node/register` or
   * `ts-node` host takes, and the one Node >= 24 handles natively by stripping
   * the annotations.
   */
  it("loads a TypeScript config", async() => {
    await write(
      "gqlize.config.ts",
      "const tag: string = 'ts';\nmodule.exports = {orm: (): any => ({tag}), out: './out.json'};",
    );
    const resolved = await loadConfig(undefined, root);
    expect((await resolved.config.orm()).tag).toEqual("ts");
  });

  it("prefers gqlize.config.ts over every other extension", async() => {
    await write("gqlize.config.ts", "module.exports = {orm: (): any => ({tag: 'ts'})};");
    await write("gqlize.config.mts", "export default {orm: () => ({tag: 'mts'})};");
    await write("gqlize.config.mjs", "export default {orm: () => ({tag: 'mjs'})};");
    await write("gqlize.config.js", CONFIG.replace("TAG", "'js'"));
    await write("gqlize.config.cjs", CONFIG.replace("TAG", "'cjs'"));
    const resolved = await loadConfig(undefined, root);
    expect((await resolved.config.orm()).tag).toEqual("ts");
  });

  it("falls back to package.json#gqlize, which points at a config module", async() => {
    await write("package.json", JSON.stringify({name: "x", gqlize: "./schema.config.cjs"}));
    const target = await write("schema.config.cjs", CONFIG.replace("TAG", "'pointer'"));
    const resolved = await loadConfig(undefined, root);
    expect(resolved.path).toEqual(target);
    // paths resolve against the config module, not the package.json
    expect(resolved.dir).toEqual(root);
    expect((await resolved.config.orm()).tag).toEqual("pointer");
  });

  it("accepts the object form of the package.json pointer", async() => {
    await write("package.json", JSON.stringify({gqlize: {config: "./schema.config.cjs"}}));
    await write("schema.config.cjs", CONFIG.replace("TAG", "'object-pointer'"));
    expect((await (await loadConfig(undefined, root)).config.orm()).tag).toEqual("object-pointer");
  });

  it("explains why the config cannot live inside package.json", async() => {
    await write("package.json", JSON.stringify({gqlize: {out: "./x.json"}}));
    await expect(loadConfig(undefined, root))
      .rejects.toThrow(/must be a path to a config module/);
  });

  it("prefers a gqlize.config.* over package.json#gqlize in the same directory", async() => {
    await write("package.json", JSON.stringify({gqlize: "./pointed.cjs"}));
    await write("pointed.cjs", CONFIG.replace("TAG", "'pointed'"));
    await write("gqlize.config.cjs", CONFIG.replace("TAG", "'dedicated'"));
    expect((await (await loadConfig(undefined, root)).config.orm()).tag).toEqual("dedicated");
  });

  it("reports when nothing was found, and says how to fix it", async() => {
    // a temp dir has no package.json and no config anywhere between it and /
    await expect(loadConfig(undefined, root)).rejects.toThrow(/no gqlize config found/);
    await expect(loadConfig(undefined, root)).rejects.toThrow(/Pass --config/);
  });

  it("accepts `export default`, `module.exports` and `export const config`", async() => {
    await write("a.mjs", "export default {orm: () => 'default'};");
    await write("b.cjs", "module.exports = {orm: () => 'module.exports'};");
    await write("c.mjs", "export const config = {orm: () => 'named'};");
    expect(await (await loadConfig(join(root, "a.mjs"))).config.orm()).toEqual("default");
    expect(await (await loadConfig(join(root, "b.cjs"))).config.orm()).toEqual("module.exports");
    expect(await (await loadConfig(join(root, "c.mjs"))).config.orm()).toEqual("named");
  });

  it("rejects a config whose `orm` is not a function", async() => {
    await write("bad.cjs", "module.exports = {out: './x.json'};");
    const load = loadConfig(join(root, "bad.cjs"));
    await expect(load).rejects.toThrow(UsageError);
    await expect(load).rejects.toThrow(/`orm` is a function/);
  });

  it("rejects a module that exports nothing usable", async() => {
    await write("empty.cjs", "module.exports = 42;");
    await expect(loadConfig(join(root, "empty.cjs")))
      .rejects.toThrow(/did not export a config object/);
  });

  /**
   * When `import()` fails because the host cannot load TypeScript, the CLI
   * re-execs itself through `tsx`. `GQLIZE_CLI_REEXEC` is what stops that
   * becoming an infinite loop — without it the re-exec would hit the same
   * failure and re-exec again. A `.tsx` config carrying real JSX is the
   * reliable trigger: Node's type stripping is strip-only, so `require` cannot
   * parse the JSX and `import()` then reports `ERR_UNKNOWN_FILE_EXTENSION` —
   * exactly the shape that would otherwise send the CLI to `tsx`.
   */
  it("does not re-exec when GQLIZE_CLI_REEXEC is already set", async() => {
    await write(
      "gqlize.config.tsx",
      "const el = <div className=\"x\" />;\nexport default {orm: () => ({tag: 'tsx'}), el};",
    );
    const previous = process.env.GQLIZE_CLI_REEXEC;
    process.env.GQLIZE_CLI_REEXEC = "1";
    try {
      await expect(loadConfig(join(root, "gqlize.config.tsx")))
        .rejects.toThrow(/failed to load config/);
    } finally {
      if (previous === undefined) {
        delete process.env.GQLIZE_CLI_REEXEC;
      } else {
        process.env.GQLIZE_CLI_REEXEC = previous;
      }
    }
  });
});

describe("isTypeScriptLoadFailure", () => {
  it("recognises the failures worth re-execing through tsx for", () => {
    expect(isTypeScriptLoadFailure({code: "ERR_UNKNOWN_FILE_EXTENSION"})).toBe(true);
    expect(isTypeScriptLoadFailure({code: "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"}))
      .toBe(true);
    expect(isTypeScriptLoadFailure({message: 'Unknown file extension ".ts" for /a/b.ts'}))
      .toBe(true);
    expect(isTypeScriptLoadFailure({message: "type stripping is disabled"})).toBe(true);
  });

  it("leaves a genuinely broken config alone", () => {
    // re-execing on these would swallow the real error behind a second failure
    expect(isTypeScriptLoadFailure({code: "ERR_MODULE_NOT_FOUND", message: "Cannot find module"}))
      .toBe(false);
    expect(isTypeScriptLoadFailure({message: "Unexpected token '}'"})).toBe(false);
    expect(isTypeScriptLoadFailure(undefined)).toBe(false);
  });
});

describe("resolveArtifactPath", () => {
  let root: string;

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), "gqlize-artifact-"));
  });

  it("falls back to the .gz sibling when only that exists", async() => {
    const path = join(root, "schema.json");
    await writeFile(`${path}.gz`, "");
    expect(await resolveArtifactPath(path)).toEqual(`${path}.gz`);
  });

  it("prefers the exact path when it exists", async() => {
    const path = join(root, "schema.json");
    await writeFile(path, "");
    await writeFile(`${path}.gz`, "");
    expect(await resolveArtifactPath(path)).toEqual(path);
  });

  it("returns the requested path unchanged when nothing is there", async() => {
    const path = join(root, "schema.json");
    expect(await resolveArtifactPath(path)).toEqual(path);
  });

  it("never appends .gz twice", async() => {
    const path = join(root, "schema.json.gz");
    expect(await resolveArtifactPath(path)).toEqual(path);
  });
});

describe("resolveOut", () => {
  it("resolves relative paths against the config directory, not the cwd", () => {
    expect(resolveOut("/a/b", "./out/schema.json")).toEqual("/a/b/out/schema.json");
    expect(resolveOut("/a/b", "../schema.json")).toEqual("/a/schema.json");
  });

  it("passes absolute paths and `undefined` through", () => {
    expect(resolveOut("/a/b", "/tmp/schema.json")).toEqual("/tmp/schema.json");
    expect(resolveOut("/a/b")).toBeUndefined();
  });
});
