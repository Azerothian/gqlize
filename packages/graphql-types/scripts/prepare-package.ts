import { globby } from 'globby';
import fs from "node:fs/promises";
import path from "node:path";

/// Generate publish/package.json: build the `exports` map (one entry per src
/// file) with dual ESM/CJS output plus a `bun` condition that resolves to the
/// TypeScript source, fix the top-level main/module/types fields, resolve
/// workspace: dependency ranges to concrete versions, and strip dev-only fields.

async function loadWorkspaceVersions() {
  const workspaceDir = path.resolve(process.cwd(), '..');
  const manifests = await globby(['*/package.json'], { cwd: workspaceDir, absolute: true });
  const versions: Record<string, string> = {};
  for (const manifest of manifests) {
    try {
      const pj = JSON.parse(await fs.readFile(manifest, 'utf-8'));
      if (pj.name && pj.version) {
        versions[pj.name] = pj.version;
      }
    } catch {
      // ignore unreadable manifests
    }
  }
  return versions;
}

function resolveWorkspaceRange(range: string, name: string, versions: Record<string, string>) {
  if (typeof range !== 'string' || !range.startsWith('workspace:')) {
    return range;
  }
  const spec = range.slice('workspace:'.length);
  const version = versions[name];
  if (!version) {
    throw new Error(`Cannot resolve workspace version for "${name}" while preparing package.json`);
  }
  if (spec === '*' || spec === '') return version;
  if (spec === '^') return `^${version}`;
  if (spec === '~') return `~${version}`;
  return spec; // explicit version or range provided after the protocol
}

async function updatePackageJson() {
  await fs.mkdir(path.join(process.cwd(), './publish'), { recursive: true });
  const files = await globby(['**/*'], {
    onlyDirectories: false,
    onlyFiles: true,
    cwd: path.resolve(process.cwd(), 'src'),
  });
  const packageJsonPath = path.join(process.cwd(), './package.json');
  const packagePublishJsonPath = path.join(process.cwd(), './publish/package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

  const exports: Record<string, Record<string, string>> = {
    ".": {
      "types": "./types/index.d.ts",
      "bun": "./src/index.ts",
      "import": "./lib/index.mjs",
      "require": "./cjs/index.js",
    },
  };
  for (const file of files) {
    let fileName = path.basename(file, '.ts');
    let dir = path.dirname(file);
    if (dir === '.') {
      dir = '';
    } else {
      dir += '/';
    }
    if (fileName.match(/\.d$/)) {
      // ambient declaration file: types only, no runtime output
      fileName = fileName.replace(/\.d$/, '');
      exports[`./${dir}${fileName}`] = {
        "types": `./types/${dir}${fileName}.d.ts`,
      };
    } else {
      exports[`./${dir}${fileName}`] = {
        "types": `./types/${dir}${fileName}.d.ts`,
        "bun": `./src/${dir}${fileName}.ts`,
        "import": `./lib/${dir}${fileName}.mjs`,
        "require": `./cjs/${dir}${fileName}.js`,
      };
    }
  }
  packageJson.exports = exports;

  // Fix the top-level entry points (the checked-in values pointed at a broken
  // ESM lib build).
  packageJson.main = "cjs/index.js";
  packageJson.module = "lib/index.mjs";
  packageJson.types = "types/index.d.ts";

  // Replace workspace: protocol ranges with concrete versions so the published
  // package is installable outside the monorepo.
  const versions = await loadWorkspaceVersions();
  for (const depType of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = packageJson[depType];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      deps[name] = resolveWorkspaceRange(deps[name], name, versions);
    }
  }

  delete packageJson.devDependencies;
  delete packageJson.scripts;

  await fs.writeFile(packagePublishJsonPath, JSON.stringify(packageJson, null, 2));
}
updatePackageJson()
