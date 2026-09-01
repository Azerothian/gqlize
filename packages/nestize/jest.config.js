const { baseProject, coverage, conventions } = require('../../scripts/jest/base-config');

/** @type {import('jest').Config} */
module.exports = {
  // The one package that compiles decorators — Nest's DI is built on them, so
  // the metadata has to survive into the test build.
  ...baseProject('nestize', {
    jsc: {
      parser: { syntax: 'typescript', tsx: true, decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      target: 'es2021',
    },
  }),
  ...coverage,
  ...conventions,
  verbose: true,
  // Suites share process-global sequelize/model registry state; run serially.
  maxWorkers: 1,
};
