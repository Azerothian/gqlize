const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('ormize-zod4'),
  ...coverage,
  ...conventions,
  verbose: true,
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
};
