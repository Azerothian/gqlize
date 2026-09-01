const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('temporalize'),
  ...coverage,
  ...conventions,
  verbose: true,
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
  // The integration suite boots a real Temporal test server (downloads a binary on
  // first run), so it is opt-in rather than part of the default `pnpm test`.
  testPathIgnorePatterns: [
    ...conventions.testPathIgnorePatterns,
    ...(process.env.TEMPORALIZE_INTEGRATION ? [] : ['/__tests__/integration/']),
  ],
};
