const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  ...baseProject('graphql-types'),
  ...coverage,
  ...conventions,
};
