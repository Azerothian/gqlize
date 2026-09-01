const { baseProject, coverage } = require('../../scripts/jest/base-config');

// Only the resolution/compilation half is shared. Everything below — three
// projects over one coverage report, the worker cap, the timeout — is this
// package's own, which is why it does not spread `conventions` like the others.
/** @type {import('jest').Config} */
const base = baseProject('gqlize');

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
  // PGlite (in-process WASM Postgres) is slower than sqlite — especially the
  // first test in a file, which lazily boots the WASM instance — and the workers
  // running it starve whatever else Jest co-schedules, so every project needs
  // more headroom than the 5s default.
  //
  // Set here at the root and NOT per-project on purpose: jest-circus seeds its
  // state with a hard-coded 5000 and only ever overwrites it from
  // `globalConfig.testTimeout` (jest-circus/build/jestAdapterInit.js — `if
  // (globalConfig.testTimeout)`). A `testTimeout` inside a `projects` entry
  // resolves into the *project* config, which circus never reads, so it is
  // silently ignored. This lived on the `postgres` project and did nothing;
  // suites timed out at 5000ms while the config claimed 30000.
  testTimeout: 30000,
  ...coverage,
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
