const { baseProject, coverage } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
const base = baseProject('ormize-zod4');

module.exports = {
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
  testTimeout: 30000,
  ...coverage,
  verbose: true,
  coveragePathIgnorePatterns: ["/node_modules/"],
  projects: [
    {
      ...base,
      displayName: 'sqlite',
      testMatch: ["**/__tests__/**/?(*.)+(spec|test).[jt]s?(x)"],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      displayName: 'postgres',
      // generate.test.ts exercises a real adapter/DB; permission-type.test.ts
      // is a pure type-system guard with no adapter at all.
      testMatch: [
        '<rootDir>/__tests__/generate.test.ts',
      ],
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
