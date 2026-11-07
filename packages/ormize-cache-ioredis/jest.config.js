const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('ormize-cache-ioredis'),
  ...coverage,
  ...conventions,
  // Suites share one redis keyspace and FLUSHALL between tests.
  maxWorkers: 1,
  // ioredis keeps handles alive past the last suite (see the valkey adapter's config).
  forceExit: true,
  testTimeout: 30000,
};
