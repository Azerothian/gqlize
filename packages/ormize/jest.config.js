const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
const base = baseProject('ormize');

// Every test file in this package exercises a real adapter/DB, so all suites
// run against both SQLite and Postgres (through PGlite).
const POSTGRES_SUITES = [
  '<rootDir>/__tests__/scope.test.ts',
  '<rootDir>/__tests__/transaction.test.ts',
  '<rootDir>/__tests__/manager.test.ts',
  '<rootDir>/__tests__/config-purity.test.ts',
  '<rootDir>/__tests__/resolution-errors.test.ts',
];

module.exports = {
  // Shared conventions: `passWithNoTests` is run-wide, so it sits at the root;
  // the ignore patterns are per project (below).
  passWithNoTests: conventions.passWithNoTests,
  maxWorkers: process.env.CI ? 2 : 4,
  // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
  // first test in a file, which lazily boots the WASM instance. Set at the root
  // because jest-circus only reads `globalConfig.testTimeout`, not per-project.
  testTimeout: 30000,
  ...coverage,
  coveragePathIgnorePatterns: ["/node_modules/"],
  projects: [
    {
      ...base,
      displayName: 'sqlite',
      testPathIgnorePatterns: conventions.testPathIgnorePatterns,
      testMatch: ["**/__tests__/**/?(*.)+(spec|test).[jt]s?(x)"],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      displayName: 'postgres',
      testPathIgnorePatterns: conventions.testPathIgnorePatterns,
      testMatch: POSTGRES_SUITES,
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
