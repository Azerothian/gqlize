const workspaceModuleNameMapper = require('../../scripts/jest/module-name-mapper');

/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testEnvironment: 'node',
  // The two adapter suites share process-global state (sequelize/model
  // registry); run serially so they don't race across parallel workers.
  maxWorkers: 1,
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  moduleNameMapper: workspaceModuleNameMapper('ormize-adapter-sequelize'),
  collectCoverage: true,
  // An allowlist, not a wildcard with exclusions: `build:src` copies the whole
  // source tree into `publish/src`, so `**/*` counts every file twice for any
  // run that follows a build — the second copy at 0%.
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageReporters: ["text-summary", "lcov"],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  passWithNoTests: true,
};
