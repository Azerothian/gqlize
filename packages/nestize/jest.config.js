const { baseProject, coverage } = require('../../scripts/jest/base-config');

// The one package that compiles decorators — Nest's DI is built on them, so
// the metadata has to survive into the test build.
/** @type {import('jest').Config} */
const base = baseProject('nestize', {
  jsc: {
    parser: { syntax: 'typescript', tsx: true, decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2021',
  },
});

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
      testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
      testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      displayName: 'postgres',
      testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
      testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
