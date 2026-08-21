import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {printSchema} from "graphql";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {run} from "../../src/cli/run";
import {VERSION} from "../../src/version";
import {SNAPSHOT_FORMAT_VERSION} from "../../src/graphql/snapshot/ir";

/**
 * End-to-end CLI tests: `run()` returns an exit code instead of calling
 * `process.exit`, so the whole binary is exercisable in-process.
 *
 * The orm is handed to the config module through a global. The config file is
 * imported natively (not through jest's registry) and so cannot resolve the
 * workspace packages from a temp directory — but it does share `globalThis`,
 * which is enough to hand it an already-built instance.
 */
describe("gqlize CLI", () => {
  let root: string;
  let out: string[];
  let err: string[];

  const io = () => ({out: (l: string) => out.push(l), err: (l: string) => err.push(l)});
  const stdout = () => out.join("\n");
  const stderr = () => err.join("\n");

  beforeAll(async() => {
    (globalThis as any).__GQLIZE_CLI_TEST_ORM__ = await createInstance();
  });

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), "gqlize-cli-"));
    out = [];
    err = [];
  });

  afterEach(async() => {
    await rm(root, {recursive: true, force: true});
  });

  /** write a config in the temp dir and return its path */
  async function config(body = "", name = "gqlize.config.cjs") {
    const path = join(root, name);
    await writeFile(
      path,
      `module.exports = {orm: () => globalThis.__GQLIZE_CLI_TEST_ORM__${body}};`,
    );
    return path;
  }

  async function artifact(path: string) {
    const raw = await readFile(path);
    return JSON.parse(
      (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"),
    );
  }

  describe("argument handling", () => {
    it("prints the version", async() => {
      expect(await run(["--version"], io())).toEqual(0);
      expect(stdout()).toEqual(VERSION);
    });

    it("prints help for a bare invocation", async() => {
      expect(await run([], io())).toEqual(0);
      expect(stdout()).toContain("gqlize build");
    });

    it("exits 2 with the help text on a usage error", async() => {
      expect(await run(["wat"], io())).toEqual(2);
      expect(stderr()).toContain('unknown command "wat"');
      expect(stderr()).toContain("Exit codes");
    });

    it("exits 2 when no config can be found", async() => {
      expect(await run(["build"], {...io(), cwd: root})).toEqual(2);
      expect(stderr()).toContain("no gqlize config found");
    });

    it("exits 2 for an unknown profile", async() => {
      const path = await config(", profiles: {admin: {}}");
      expect(await run(["build", "-c", path, "-p", "nope"], io())).toEqual(2);
      expect(stderr()).toContain('unknown profile "nope"');
      expect(stderr()).toContain("config declares admin");
    });
  });

  describe("build", () => {
    it("writes an artifact next to the config and reports what it wrote", async() => {
      const path = await config();
      expect(await run(["build", "-c", path], io())).toEqual(0);

      const written = await artifact(join(root, "gqlize.schema.json"));
      expect(written.formatVersion).toEqual(SNAPSHOT_FORMAT_VERSION);
      expect(written.types.length).toBeGreaterThan(0);
      expect(written.fingerprint).toBeTruthy();
      expect(stdout()).toContain("gqlize.schema.json");
      expect(stdout()).toMatch(/\d+ types, \d+ fields/);
    });

    it("finds the config by walking up from the cwd", async() => {
      await config();
      expect(await run(["build"], {...io(), cwd: root})).toEqual(0);
      expect(await artifact(join(root, "gqlize.schema.json"))).toBeTruthy();
    });

    it("honours --out and writes an SDL sidecar with --sdl", async() => {
      const path = await config();
      const outFile = join(root, "nested", "schema.json");
      const sdlFile = join(root, "nested", "schema.graphql");
      expect(await run(["build", "-c", path, "-o", outFile, "--sdl", sdlFile], io())).toEqual(0);

      expect((await artifact(outFile)).types.length).toBeGreaterThan(0);
      const sdl = await readFile(sdlFile, "utf8");
      expect(sdl).toEqual(printSchema(await createSchema((globalThis as any).__GQLIZE_CLI_TEST_ORM__)));
    });

    it("gzips with --gzip, appending .gz", async() => {
      const path = await config();
      expect(await run(["build", "-c", path, "--gzip"], io())).toEqual(0);
      const written = join(root, "gqlize.schema.json.gz");
      expect((await readFile(written))[0]).toEqual(0x1f);
      expect((await artifact(written)).formatVersion).toEqual(SNAPSHOT_FORMAT_VERSION);
      expect(stdout()).toContain("(gzip)");
    });

    it("writes compact JSON by default, and indents under --pretty", async() => {
      // an artifact is a build output, not a file anyone reads by hand: the
      // indentation nearly doubles it for no runtime benefit. `--pretty` is
      // still there for anyone diffing one by eye.
      const path = await config();
      await run(["build", "-c", path, "-o", join(root, "default.json")], io());
      await run(["build", "-c", path, "-o", join(root, "pretty.json"), "--pretty"], io());
      const min = await readFile(join(root, "default.json"), "utf8");
      const pretty = await readFile(join(root, "pretty.json"), "utf8");
      expect(min).not.toContain("\n");
      expect(pretty).toContain("\n  ");
      expect(min.length).toBeLessThan(pretty.length);
      expect(JSON.parse(min)).toEqual(JSON.parse(pretty));
    });

    it("gives every profile its own file under --all-profiles", async() => {
      // the suffix rule is what stops two profiles silently overwriting one file
      const path = await config(", out: './schema.json', profiles: {admin: {}, anon: {}}");
      expect(await run(["build", "-c", path, "--all-profiles"], io())).toEqual(0);

      const admin = await artifact(join(root, "schema.admin.json"));
      const anon = await artifact(join(root, "schema.anon.json"));
      expect(admin.fingerprint.permissionProfile).toEqual("admin");
      expect(anon.fingerprint.permissionProfile).toEqual("anon");
      expect(stdout()).toContain("admin: ");
      expect(stdout()).toContain("anon: ");
    });

    it("records --permission-profile in the fingerprint", async() => {
      const path = await config();
      expect(await run(["build", "-c", path, "--permission-profile", "readonly"], io())).toEqual(0);
      expect((await artifact(join(root, "gqlize.schema.json"))).fingerprint.permissionProfile)
        .toEqual("readonly");
    });
  });

  describe("check", () => {
    it("exits 0 for a fresh artifact", async() => {
      const path = await config();
      await run(["build", "-c", path], io());
      out = [];
      expect(await run(["check", "-c", path], io())).toEqual(0);
      expect(stdout()).toContain("— ok");
    });

    it("exits 1 when the artifact is stale", async() => {
      const path = await config();
      await run(["build", "-c", path], io());

      const file = join(root, "gqlize.schema.json");
      const stale = await artifact(file);
      stale.fingerprint.models = "0".repeat(64);
      await writeFile(file, JSON.stringify(stale));

      expect(await run(["check", "-c", path], io())).toEqual(1);
      expect(stderr()).toContain("is stale — models differ");
    });

    it("exits 1 when the permission profile does not match", async() => {
      // the one drift the fingerprint *can* see about permissions
      const path = await config();
      await run(["build", "-c", path, "--permission-profile", "admin"], io());
      expect(await run(["check", "-c", path, "--permission-profile", "anon"], io())).toEqual(1);
      expect(stderr()).toContain("permissionProfile");
    });

    it("exits 1 when the artifact is missing, naming the path", async() => {
      const path = await config();
      expect(await run(["check", "-c", path], io())).toEqual(1);
      expect(stderr()).toContain("gqlize.schema.json");
      // the `.gz` fallback must not rewrite the name when nothing is there either
      expect(stderr()).not.toContain(".json.gz");
    });

    it("exits 1 when the artifact carries no fingerprint", async() => {
      const path = await config();
      await run(["build", "-c", path], io());
      const file = join(root, "gqlize.schema.json");
      const unsigned = await artifact(file);
      delete unsigned.fingerprint;
      await writeFile(file, JSON.stringify(unsigned));

      expect(await run(["check", "-c", path], io())).toEqual(1);
      expect(stderr()).toContain("has no fingerprint");
    });

    it("says so when --no-strict skips the live SDL diff", async() => {
      const path = await config();
      await run(["build", "-c", path], io());
      out = [];
      expect(await run(["check", "-c", path, "--no-strict"], io())).toEqual(0);
      expect(stdout()).toContain("permission drift is not covered");
    });

    it("checks an explicit --artifact", async() => {
      const path = await config();
      const file = join(root, "elsewhere.json");
      await run(["build", "-c", path, "-o", file], io());
      expect(await run(["check", "-c", path, "--artifact", file], io())).toEqual(0);
    });

    it("fails the run if any one profile is stale", async() => {
      const path = await config(", out: './schema.json', profiles: {admin: {}, anon: {}}");
      await run(["build", "-c", path, "--all-profiles"], io());
      await rm(join(root, "schema.anon.json"));
      expect(await run(["check", "-c", path, "--all-profiles"], io())).toEqual(1);
      expect(stderr()).toContain("anon: ");
    });

    /**
     * The reason `--strict` exists (risk R5). `options.permission` is a bag of
     * closures, so the fingerprint cannot hash it: an artifact built with one
     * predicate body and served under another has an *identical* fingerprint.
     * Both configs below declare the same `permission.field` key — so
     * `optionsShape` matches too — and differ only in what the predicate
     * returns. Only the live SDL diff can see it.
     */
    describe("--strict catches permission drift the fingerprint cannot", () => {
      const PERMISSIVE = ", options: {permission: {field: () => true}}";
      const RESTRICTIVE =
        ", options: {permission: {field: (m, f) => !(m === 'Task' && f === 'name')}}";

      it("exits 1 and names the first differing line", async() => {
        const built = await config(PERMISSIVE, "permissive.config.cjs");
        const served = await config(RESTRICTIVE, "restrictive.config.cjs");
        await run(["build", "-c", built], io());

        out = [];
        err = [];
        expect(await run(["check", "-c", served], io())).toEqual(1);
        expect(stderr()).toContain("does not match a live build");
        // `firstDiff` output: the live build lost `Task.name`, the artifact kept it
        expect(stderr()).toMatch(/\d+ live: {5}/);
        expect(stderr()).toMatch(/\d+ artifact: /);
      });

      it("passes --no-strict, because the fingerprint is genuinely identical", async() => {
        const built = await config(PERMISSIVE, "permissive.config.cjs");
        const served = await config(RESTRICTIVE, "restrictive.config.cjs");
        await run(["build", "-c", built], io());

        out = [];
        expect(await run(["check", "-c", served, "--no-strict"], io())).toEqual(0);
        expect(stdout()).toContain("permission drift is not covered");
      });
    });

    it("finds a gzipped artifact without being told it is gzipped", async() => {
      // `--gzip` is a *build* flag; nobody passes it to `check`
      const path = await config();
      await run(["build", "-c", path, "--gzip"], io());

      out = [];
      expect(await run(["check", "-c", path], io())).toEqual(0);
      expect(stdout()).toContain("gqlize.schema.json.gz");
    });

  });

  describe("print", () => {
    it("prints the live schema as SDL", async() => {
      const path = await config();
      expect(await run(["print", "-c", path], io())).toEqual(0);
      expect(stdout()).toEqual(printSchema(await createSchema((globalThis as any).__GQLIZE_CLI_TEST_ORM__)));
    });

    it("prints from an artifact, matching a live build", async() => {
      const path = await config();
      const file = join(root, "gqlize.schema.json");
      await run(["build", "-c", path], io());

      out = [];
      expect(await run(["print", "-c", path, "--from-artifact", file, "--sorted"], io())).toEqual(0);
      const fromArtifact = stdout();

      out = [];
      await run(["print", "-c", path, "--sorted"], io());
      expect(fromArtifact).toEqual(stdout());
    });
  });
});
