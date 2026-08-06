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
  // Resolve sibling workspace packages from source. Order: most specific first.
  moduleNameMapper: {
    '^@azerothian/ormize-adapter-sequelize$': '<rootDir>/../ormize-adapter-sequelize/src/index.ts',
    '^@azerothian/ormize-adapter-sequelize/(.*)$': '<rootDir>/../ormize-adapter-sequelize/src/$1',
    '^@azerothian/ormize$': '<rootDir>/../ormize/src/index.ts',
    '^@azerothian/ormize/(.*)$': '<rootDir>/../ormize/src/$1',
    '^@azerothian/utilize$': '<rootDir>/../utilize/src/index.ts',
    '^@azerothian/utilize/(.*)$': '<rootDir>/../utilize/src/$1',
    '^@azerothian/gqlize$': '<rootDir>/../gqlize/src/index.ts',
    '^@azerothian/gqlize/(.*)$': '<rootDir>/../gqlize/src/$1',
    '^@azerothian/graphql-types$': '<rootDir>/../graphql-types/src/index.ts',
    '^@azerothian/graphql-types/(.*)$': '<rootDir>/../graphql-types/src/$1',
  },
  collectCoverage: false,
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  passWithNoTests: true,
  testTimeout: 30000,
};
