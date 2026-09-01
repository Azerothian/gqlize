const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('ormize-adapter-sequelize'),
  ...coverage,
  ...conventions,
  verbose: true,
  // The two adapter suites share process-global state (sequelize/model
  // registry); run serially so they don't race across parallel workers.
  maxWorkers: 1,
  watchPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
};
