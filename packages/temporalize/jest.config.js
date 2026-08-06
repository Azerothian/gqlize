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
  // Resolve sibling workspace packages from source (most specific first).
  moduleNameMapper: {
    '^@azerothian/ormize-adapter-sequelize$': '<rootDir>/../ormize-adapter-sequelize/src/index.ts',
    '^@azerothian/ormize-adapter-sequelize/(.*)$': '<rootDir>/../ormize-adapter-sequelize/src/$1',
    '^@azerothian/ormize-zod4$': '<rootDir>/../ormize-zod4/src/index.ts',
    '^@azerothian/ormize-zod4/(.*)$': '<rootDir>/../ormize-zod4/src/$1',
    '^@azerothian/ormize$': '<rootDir>/../ormize/src/index.ts',
    '^@azerothian/ormize/(.*)$': '<rootDir>/../ormize/src/$1',
    '^@azerothian/utilize$': '<rootDir>/../utilize/src/index.ts',
    '^@azerothian/utilize/(.*)$': '<rootDir>/../utilize/src/$1',
    '^@azerothian/graphql-types$': '<rootDir>/../graphql-types/src/index.ts',
    '^@azerothian/graphql-types/(.*)$': '<rootDir>/../graphql-types/src/$1',
  },
  collectCoverage: false,
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  // The integration suite boots a real Temporal test server (downloads a binary on
  // first run), so it is opt-in rather than part of the default `pnpm test`.
  testPathIgnorePatterns: [
    '/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/',
    ...(process.env.TEMPORALIZE_INTEGRATION ? [] : ['/__tests__/integration/']),
  ],
  passWithNoTests: true,
};
