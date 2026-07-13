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
  // Resolve sibling workspace packages from source. Order: most specific first.
  moduleNameMapper: {
    '^@azerothian/gqlize$': '<rootDir>/../gqlize/src/index.ts',
    '^@azerothian/gqlize/(.*)$': '<rootDir>/../gqlize/src/$1',
    '^@azerothian/gqlize-shared$': '<rootDir>/../gqlize-shared/src/index.ts',
    '^@azerothian/gqlize-shared/(.*)$': '<rootDir>/../gqlize-shared/src/$1',
    '^@azerothian/graphql-types$': '<rootDir>/../graphql-types/src/index.ts',
    '^@azerothian/graphql-types/(.*)$': '<rootDir>/../graphql-types/src/$1',
  },
  collectCoverage: false,
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  passWithNoTests: true,
};
