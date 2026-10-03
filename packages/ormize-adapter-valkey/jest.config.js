const { baseProject, coverage } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
const base = baseProject('ormize-adapter-valkey');

// Suites that exercise a Sequelize side — worth running on Postgres too.
// Valkey-only suites (no Sequelize) need not run twice.
const POSTGRES_SUITES = [
  '<rootDir>/__tests__/relations.test.ts',
  '<rootDir>/__tests__/cross-adapter.test.ts',
  '<rootDir>/__tests__/adapter-parity.test.ts',
  '<rootDir>/__tests__/model-api.test.ts',
  '<rootDir>/__tests__/ormize.test.ts',
  '<rootDir>/__tests__/scope.test.ts',
];

module.exports = {
  // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
  // first test in a file, which lazily boots the WASM instance. Must be at the
  // config root: jest-circus reads `globalConfig.testTimeout` and silently
  // ignores a `testTimeout` inside a `projects` entry.
  testTimeout: 30000,
  // Suites share a single redis instance / keyspace; run serially.
  maxWorkers: 1,
  // ioredis keeps handles alive past the last suite, which otherwise leaves the
  // run hanging after every test has already passed.
  forceExit: true,
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
      testMatch: POSTGRES_SUITES,
      testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
