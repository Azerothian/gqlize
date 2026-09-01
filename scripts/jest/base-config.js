const workspaceModuleNameMapper = require('./module-name-mapper');

/// The pieces of a jest config every package genuinely shares.
///
/// Deliberately *not* a whole config. Only one of the nine packages could use
/// one unchanged — the rest carry settings that are load-bearing and specific:
/// `maxWorkers: 1` where suites share a process-global sequelize/model registry,
/// `forceExit` where ioredis keeps handles alive past the last suite, an
/// `TEMPORALIZE_INTEGRATION` gate on a suite that downloads a Temporal server,
/// legacy decorators for nestize. So this exports the shared halves and each
/// package spreads what it needs and states its own.
///
/// What was actually duplicated is here: the resolution/compilation block (all
/// nine, modulo nestize's decorators) and the coverage block — whose four-line
/// comment had nine homes and therefore nine chances to stop being true.

/// Resolution + compilation. `swcOptions` overrides the `jsc` block, for the one
/// package that compiles decorators.
function baseProject(self, swcOptions) {
  return {
    testEnvironment: 'node',
    transform: {
      '^.+\\.[tj]sx?$': ['@swc/jest', {
        jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
        module: { type: 'commonjs' },
        ...(swcOptions || {}),
      }],
    },
    moduleNameMapper: workspaceModuleNameMapper(self),
  };
}

/// Run-wide coverage settings. Only meaningful at the top level of a config —
/// jest ignores these inside a `projects` entry.
const coverage = {
  collectCoverage: true,
  // An allowlist, not a wildcard with exclusions: `build:src` copies the whole
  // source tree into `publish/src`, so `**/*` counts every file twice for any
  // run that follows a build — the second copy at 0%.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text-summary', 'lcov'],
};

/// The conventions every suite in this repo shares: where tests live, and the
/// build outputs that must never be scanned for them.
const conventions = {
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/.yalc/', '/.devcontainer/'],
  passWithNoTests: true,
};

module.exports = { baseProject, coverage, conventions };
