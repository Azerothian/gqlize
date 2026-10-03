const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

const base = baseProject('ormize-adapter-sequelize');

// `passWithNoTests` is a root-level setting — jest ignores it inside a project.
// eslint-disable-next-line no-unused-vars -- destructured to remove it from the project spread
const { passWithNoTests, ...projectConventions } = conventions;

// Every suite that opens a database — worth running against Postgres too.
// Pure-unit sequelize-filter.test.ts is excluded: it imports functions directly
// and constructs no adapter.
const POSTGRES_SUITES = [
  '<rootDir>/__tests__/define-model.test.ts',
  '<rootDir>/__tests__/initialise-ddl.test.ts',
  '<rootDir>/__tests__/instance-hooks.test.ts',
  '<rootDir>/__tests__/map-data-type.test.ts',
  '<rootDir>/__tests__/nested-subquery.test.ts',
  '<rootDir>/__tests__/paranoid.test.ts',
  '<rootDir>/__tests__/replace-id-codec.test.ts',
  '<rootDir>/__tests__/replace-id-in-where.test.ts',
  '<rootDir>/__tests__/sequelize.test.ts',
];

/** @type {import('jest').Config} */
module.exports = {
  // The two adapter suites share process-global state (sequelize/model
  // registry); run serially so they don't race across parallel workers.
  maxWorkers: 1,
  // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
  // first test in a file, which lazily boots the WASM instance — so every
  // project needs more headroom than the 5s default.
  //
  // Set here at the root and NOT per-project: jest-circus seeds its state with
  // a hard-coded 5000 and only ever overwrites it from
  // `globalConfig.testTimeout`, so a `testTimeout` inside a `projects` entry
  // is silently ignored.
  testTimeout: 30000,
  passWithNoTests: true,
  ...coverage,
  projects: [
    {
      ...base,
      ...projectConventions,
      displayName: 'sqlite',
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      ...projectConventions,
      displayName: 'postgres',
      testMatch: POSTGRES_SUITES,
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
