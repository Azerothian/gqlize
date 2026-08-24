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
    '^@azerothian/ormize-adapter-sequelize$': '<rootDir>/../ormize-adapter-sequelize/src/index.ts',
    '^@azerothian/ormize-adapter-sequelize/(.*)$': '<rootDir>/../ormize-adapter-sequelize/src/$1',
    '^@azerothian/ormize$': '<rootDir>/../ormize/src/index.ts',
    '^@azerothian/ormize/(.*)$': '<rootDir>/../ormize/src/$1',
    '^@azerothian/utilize$': '<rootDir>/../utilize/src/index.ts',
    '^@azerothian/utilize/(.*)$': '<rootDir>/../utilize/src/$1',
    '^@azerothian/gqlize$': '<rootDir>/src/index.ts',
    '^@azerothian/gqlize/(.*)$': '<rootDir>/src/$1',
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
  '<rootDir>/__tests__/include-leaf-model.test.ts',
  '<rootDir>/__tests__/where-variables.test.ts',
];

// Functional suites re-run against a schema that has been through the artifact
// (build -> snapshot -> JSON -> materialize). Keep this always-on in CI: it is
// what stops a resolver binding from drifting between the live builder and the
// loader. Excludes `schema-golden` and `__tests__/snapshot/*` — those assert the
// build path itself, and `__tests__/graphql/*` unit-test the builders directly.
const ROUNDTRIP_SUITES = [
  '<rootDir>/__tests__/query.test.ts',
  '<rootDir>/__tests__/query-eager.test.ts',
  '<rootDir>/__tests__/query-count.test.ts',
  '<rootDir>/__tests__/mutation.test.ts',
  '<rootDir>/__tests__/mutation-relationships.test.ts',
  '<rootDir>/__tests__/relay.test.ts',
  '<rootDir>/__tests__/permission.test.ts',
  '<rootDir>/__tests__/permission-helper.test.ts',
  '<rootDir>/__tests__/comments.test.ts',
  '<rootDir>/__tests__/include-leaf-model.test.ts',
  '<rootDir>/__tests__/where-variables.test.ts',
  '<rootDir>/__tests__/pageinfo.test.ts',
];

module.exports = {
  // Each postgres test file spins up an in-process PGlite (WASM) instance; too
  // many concurrent instances exhaust resources on high-core machines, so cap
  // worker concurrency. sqlite-only runs are fast enough that this is a non-issue.
  // On CI (few cores, slower) run fewer workers to avoid oversubscription.
  maxWorkers: process.env.CI ? 2 : 4,
  collectCoverage: true,
  // An allowlist, not a wildcard with exclusions: `build:src` copies the whole
  // source tree into `publish/src`, so `**/*` counts every file twice for any
  // run that follows a build — the second copy at 0%.
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageReporters: ["text-summary", "lcov"],
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
      // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
      // first test in a file which lazily boots the WASM instance — so allow more
      // headroom than the 5s default, which otherwise flakes on CI.
      testTimeout: 30000,
      setupFiles: ['<rootDir>/__tests__/setup/dialect-postgres.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
    },
    {
      ...base,
      displayName: 'roundtrip',
      testMatch: ROUNDTRIP_SUITES,
      setupFiles: ['<rootDir>/__tests__/setup/dialect-sqlite.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/setup/teardown.ts'],
      // Anchored exactly, so `__tests__/graphql/*` (which import
      // `../../src/graphql/create-*`) keep hitting the real builders.
      moduleNameMapper: {
        '^\\.\\./src$': '<rootDir>/__tests__/setup/roundtrip-src.ts',
        ...base.moduleNameMapper,
      },
    },
  ],
};
