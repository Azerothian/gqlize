const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
const base = baseProject('temporalize');

// The integration suite boots a real Temporal test server (downloads a binary on
// first run), so it is opt-in rather than part of the default `pnpm test`.
const integrationIgnore = process.env.TEMPORALIZE_INTEGRATION ? [] : ['/__tests__/integration/'];

module.exports = {
  // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
  // first test in a file, which lazily boots the WASM instance. Must be at the
  // config root: jest-circus reads `globalConfig.testTimeout` and silently
  // ignores a `testTimeout` inside a `projects` entry.
  testTimeout: 30000,
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
  ...coverage,
  verbose: true,
  passWithNoTests: true,
  projects: [
    {
      ...base,
      displayName: 'sqlite',
      testMatch: conventions.testMatch,
      testPathIgnorePatterns: [
        ...conventions.testPathIgnorePatterns,
        ...integrationIgnore,
      ],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      displayName: 'postgres',
      testMatch: conventions.testMatch,
      testPathIgnorePatterns: [
        ...conventions.testPathIgnorePatterns,
        ...integrationIgnore,
      ],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
