// Native Node tests over the *built* packages (`publish/`), run after
// `pnpm build` by `pnpm test:packaging`. Jest can't cover this: it maps every
// workspace import to `src/` and transforms it, so it never touches the
// published `exports` conditions this file checks.
//
// The hazard (#82): `require` resolved to cjs/ and `import` to lib/, so a
// process that loaded a package both ways held two copies of every module-level
// singleton. Two GQLTDate scalars in one schema fail `new GraphQLSchema`.
// `scripts/build/prepare-package.ts` adds a `module-sync` condition so Node
// loads the ESM file for both.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const packagesDir = path.join(repoRoot, "packages");

function publishedManifest(dir) {
  const file = path.join(packagesDir, dir, "publish/package.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

describe("every published manifest", () => {
  const dirs = fs.readdirSync(packagesDir).filter((dir) => publishedManifest(dir));

  test("found built packages (run `pnpm build` first)", () => {
    assert.ok(dirs.includes("graphql-types"), "packages/graphql-types/publish is missing");
  });

  for (const dir of dirs) {
    test(`${dir}: module-sync precedes import/require and targets the ESM file`, () => {
      for (const [subpath, conditions] of Object.entries(publishedManifest(dir).exports)) {
        if (!conditions.import) continue; // types-only entry
        const keys = Object.keys(conditions);
        assert.equal(conditions["module-sync"], conditions.import, `${subpath}`);
        assert.ok(
          keys.indexOf("module-sync") < keys.indexOf("import")
            && keys.indexOf("module-sync") < keys.indexOf("require"),
          `${subpath}: condition order ${keys.join(", ")}`,
        );
      }
    });
  }

  // A config that imports `@azerothian/gqlize` resolves to lib/ through
  // module-sync. A bin in cjs/ would be a second copy of gqlize, with its own
  // build registry, which `gqlize check` reads.
  test("gqlize: the bin runs the ESM build", () => {
    const { bin } = publishedManifest("gqlize");
    assert.match(bin.gqlize, /^\.\/lib\/.*\.mjs$/);
  });
});

// Install graphql-types and utilize, as published, into a scratch
// node_modules. The `publish/` dirs can't be loaded in place: their realpath
// sits inside the workspace, where `@azerothian/*` links point at unbuilt source
// packages. Third-party dependencies are linked from the package's own
// node_modules.
function stage(root, dir) {
  const manifest = publishedManifest(dir);
  const target = path.join(root, "node_modules", manifest.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(packagesDir, dir, "publish"), target, { recursive: true });
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  for (const dep of Object.keys(deps)) {
    if (dep.startsWith("@azerothian/")) continue;
    const link = path.join(root, "node_modules", dep);
    if (fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(packagesDir, dir, "node_modules", dep)), link);
  }
}

// Runs as a plain .mjs in the scratch dir, so every specifier goes through
// Node's real resolver and the package `exports` conditions.
const PROBE = `
import { createRequire } from "node:module";
import { GraphQLObjectType, GraphQLSchema, GraphQLString, validateSchema } from "graphql";

const require = createRequire(import.meta.url);
const SCALARS = ["bigint", "date", "ip", "json", "upload"];
const out = { subpaths: {}, barrel: {}, resolved: {} };

const queryFields = {};
const mutationArgs = {};
for (const name of SCALARS) {
  const spec = "@azerothian/graphql-types/" + name;
  const esm = (await import(spec)).default;
  const cjs = require(spec).default;
  out.subpaths[name] = { name: esm.name, same: esm === cjs };
  out.resolved[name] = require.resolve(spec);
  queryFields[name] = { type: esm };
  mutationArgs[name] = { type: cjs };
}

const esmBarrel = await import("@azerothian/graphql-types");
const cjsBarrel = require("@azerothian/graphql-types");
for (const key of Object.keys(esmBarrel)) {
  out.barrel[key] = esmBarrel[key] === cjsBarrel[key];
}
out.barrelMatchesSubpath = cjsBarrel.DateType === (await import("@azerothian/graphql-types/date")).default;

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
  mutation: new GraphQLObjectType({
    name: "Mutation",
    fields: { update: { type: GraphQLString, args: mutationArgs } },
  }),
});
out.schemaErrors = validateSchema(schema).map((e) => e.message);

// An SWC-compiled CJS consumer reads \`.default\` through this interop, so the
// require()d ESM namespace must carry __esModule.
const interop = (m) => (m && m.__esModule ? m : { default: m });
out.interopName = interop(require("@azerothian/graphql-types/date")).default.name;

console.log(JSON.stringify(out));
`;

describe("@azerothian/graphql-types loaded by require() and import()", () => {
  let root;
  let result;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gqlize-dual-package-"));
    stage(root, "utilize");
    stage(root, "graphql-types");
    fs.writeFileSync(path.join(root, "probe.mjs"), PROBE);
    result = JSON.parse(execFileSync(process.execPath, ["probe.mjs"], { cwd: root, encoding: "utf8" }));
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("require() resolves each subpath to the ESM build", () => {
    for (const [name, file] of Object.entries(result.resolved)) {
      assert.match(file, /[\\/]lib[\\/][^\\/]+\.mjs$/, name);
    }
  });

  test("each scalar subpath yields one instance", () => {
    for (const [name, { same }] of Object.entries(result.subpaths)) {
      assert.equal(same, true, `${name}: require() and import() returned different instances`);
    }
  });

  test("each barrel export yields one instance, shared with its subpath", () => {
    assert.ok(Object.keys(result.barrel).length > 0);
    for (const [key, same] of Object.entries(result.barrel)) {
      assert.equal(same, true, `barrel export ${key} differs between require() and import()`);
    }
    assert.equal(result.barrelMatchesSubpath, true);
  });

  test("a schema mixing ESM and CJS scalars builds and validates", () => {
    assert.deepEqual(result.schemaErrors, []);
  });

  test("CJS interop still reads the default export", () => {
    assert.equal(result.interopName, "GQLTDate");
  });
});
