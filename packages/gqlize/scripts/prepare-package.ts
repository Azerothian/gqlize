import { globby } from 'globby';
import fs from "node:fs/promises";
import path from "node:path";

/// create a function that uses globby to find all files in the src directory and updates the package.json file
/// to add import and require statements for each file found to the exports section of the package.json file

/// Build a name -> version map of every package in the monorepo so we can
/// replace `workspace:*` style ranges with real, publishable versions.
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
  const exports = {
    ".": {
      "import": "./lib/index.mjs",
      "require": "./cjs/index.js",
      "types": "./types/index.d.ts",
    }
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
      fileName = fileName.replace(/\.d$/, '');
      exports[`./${dir}${fileName}`] = {
        "types": `./types/${dir}${fileName}.d.ts`,
      };
    } else {
      exports[`./${dir}${fileName}`] = {
        "import": `./lib/${dir}${fileName}.mjs`,
        "require": `./cjs/${dir}${fileName}.js`,
        "types": `./types/${dir}${fileName}.d.ts`,
      };
    }
  }
  packageJson.exports = exports;

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
