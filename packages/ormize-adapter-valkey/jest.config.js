const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('ormize-adapter-valkey'),
  ...coverage,
  ...conventions,
  verbose: true,
  // Suites share a single redis instance / keyspace; run serially.
  maxWorkers: 1,
  // ioredis keeps handles alive past the last suite, which otherwise leaves the
  // run hanging after every test has already passed.
  forceExit: true,
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  testTimeout: 30000,
};
