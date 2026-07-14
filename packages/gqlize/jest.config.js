/** @type {import('jest').Config} */
const base = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  // Resolve sibling workspace packages from source (their published `exports`
  // subpaths only exist after a build). Order: most specific first.
  moduleNameMapper: {
    '^@azerothian/gqlize-adapter-sequelize$': '<rootDir>/../gqlize-adapter-sequelize/src/index.ts',
    '^@azerothian/gqlize-adapter-sequelize/(.*)$': '<rootDir>/../gqlize-adapter-sequelize/src/$1',
    '^@azerothian/gqlize-shared$': '<rootDir>/../gqlize-shared/src/index.ts',
    '^@azerothian/gqlize-shared/(.*)$': '<rootDir>/../gqlize-shared/src/$1',
    '^@azerothian/graphql-types$': '<rootDir>/../graphql-types/src/index.ts',
    '^@azerothian/graphql-types/(.*)$': '<rootDir>/../graphql-types/src/$1',
  },
};

// Functional + DB-behaviour suites that exercise real adapter/DB behaviour and so
// are worth running against Postgres too. Pure schema-builder unit tests
// (graphql/create-*, manager) stay sqlite-only.
const POSTGRES_SUITES = [
  '<rootDir>/__tests__/query.test.ts',
  '<rootDir>/__tests__/query-eager.test.ts',
  '<rootDir>/__tests__/query-count.test.ts',
  '<rootDir>/__tests__/mutation.test.ts',
  '<rootDir>/__tests__/mutation-relationships.test.ts',
  '<rootDir>/__tests__/relay.test.ts',
  '<rootDir>/__tests__/permission.test.ts',
  '<rootDir>/__tests__/comments.test.ts',
];

module.exports = {
  // Each postgres test file spins up an in-process PGlite (WASM) instance; too
  // many concurrent instances exhaust resources on high-core machines, so cap
  // worker concurrency. sqlite-only runs are fast enough that this is a non-issue.
  maxWorkers: 4,
  collectCoverage: true,
  collectCoverageFrom: [
    "**/*.{ts,js}",
    "!**/node_modules/**",
    "!**/coverage/**",
    "!src/types/**",
    "!lib/**",
    "!jest.config.js",
    "!.yalc/**",
    "!__tests__/**",
  ],
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
      testMatch: POSTGRES_SUITES,
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
  ],
};
