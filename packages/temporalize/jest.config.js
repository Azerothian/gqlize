const workspaceModuleNameMapper = require('../../scripts/jest/module-name-mapper');

/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testEnvironment: 'node',
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'typescript', tsx: true },
        target: 'es2022',
      },
      module: { type: 'commonjs' },
    }],
  },
  moduleNameMapper: workspaceModuleNameMapper('temporalize'),
  collectCoverage: true,
  // An allowlist, not a wildcard with exclusions: `build:src` copies the whole
  // source tree into `publish/src`, so `**/*` counts every file twice for any
  // run that follows a build — the second copy at 0%.
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageReporters: ["text-summary", "lcov"],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  // The integration suite boots a real Temporal test server (downloads a binary on
  // first run), so it is opt-in rather than part of the default `pnpm test`.
  testPathIgnorePatterns: [
    '/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/',
    ...(process.env.TEMPORALIZE_INTEGRATION ? [] : ['/__tests__/integration/']),
  ],
  passWithNoTests: true,
};
