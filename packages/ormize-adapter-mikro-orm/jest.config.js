const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('ormize-adapter-mikro-orm'),
  ...coverage,
  ...conventions,
  verbose: true,
  // Suites share the process-global MikroORM metadata storage; run serially.
  maxWorkers: 1,
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  // MikroORM v7 is published as pure ESM ("type": "module", no CJS build), and
  // jest runs this repo's suites in CJS. The default `transformIgnorePatterns`
  // skips everything under node_modules, so the ESM arrives unparsed; naming the
  // scope here lets @swc/jest compile it down like any other source file.
  // pnpm's store puts the real files under `.pnpm/<pkg>@<ver>/node_modules/`,
  // which is why the pattern matches the scope anywhere in the path.
  transformIgnorePatterns: ['/node_modules/(?!(\\.pnpm/)?(@mikro-orm|kysely)[+@/])'],
  testTimeout: 30000,
};
