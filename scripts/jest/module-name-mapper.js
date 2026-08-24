const fs = require('node:fs');
const path = require('node:path');

/// Resolve every workspace package to its *source*. A package's published
/// `exports` subpaths only exist under `publish/` after a build, so a
/// from-source map is what lets `pnpm test` run without one.
///
/// Generated from the packages directory rather than written out per package.
/// The workspace graph was previously maintained by hand in three parallel
/// places — this map, tsconfig `paths`, and tsconfig `references` — and each
/// package listed a different subset of it.
///
/// `self` is the directory name of the package doing the requiring; its own
/// entries point at `<rootDir>` rather than a sibling. Every config gets the
/// full map: a mapping for a package this one never imports is inert.
module.exports = function workspaceModuleNameMapper(self) {
  const packagesDir = path.resolve(__dirname, '../../packages');
  const dirs = fs
    .readdirSync(packagesDir)
    .filter((d) => fs.existsSync(path.join(packagesDir, d, 'package.json')))
    // Longest first. The patterns are anchored (`$` / `/`), so `@azerothian/ormize`
    // cannot swallow `@azerothian/ormize-zod4` either way — this just keeps the
    // emitted order readable and matches what the hand-written maps did.
    .sort((a, b) => b.length - a.length);

  const map = {};
  for (const dir of dirs) {
    const manifest = path.join(packagesDir, dir, 'package.json');
    const {name} = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const root = dir === self ? '<rootDir>' : `<rootDir>/../${dir}`;
    map[`^${name}$`] = `${root}/src/index.ts`;
    map[`^${name}/(.*)$`] = `${root}/src/$1`;
  }
  return map;
};
