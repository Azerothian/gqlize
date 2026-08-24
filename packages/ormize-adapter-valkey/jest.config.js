const workspaceModuleNameMapper = require('../../scripts/jest/module-name-mapper');

/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testEnvironment: 'node',
  // Suites share a single redis instance / keyspace; run serially.
  maxWorkers: 1,
  // ioredis keeps handles alive past the last suite, which otherwise leaves the
  // run hanging after every test has already passed.
  forceExit: true,
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  moduleNameMapper: workspaceModuleNameMapper('ormize-adapter-valkey'),
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
  testTimeout: 30000,
};
