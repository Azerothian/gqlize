/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ["**/__tests__/**/?(*.)+(spec|test).[jt]s?(x)"],
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  // Resolve sibling workspace packages from source (their published `exports`
  // subpaths only exist after a build). Order: most specific first.
  moduleNameMapper: {
    '^@azerothian/gqlize-adapter-sequelize$': '<rootDir>/../gqlize-adapter-sequelize/src/index.ts',
    '^@azerothian/gqlize-adapter-sequelize/(.*)$': '<rootDir>/../gqlize-adapter-sequelize/src/$1',
    '^@azerothian/gqlize-shared$': '<rootDir>/../gqlize-shared/src/index.ts',
    '^@azerothian/gqlize-shared/(.*)$': '<rootDir>/../gqlize-shared/src/$1',
  },
  collectCoverage: true,
  collectCoverageFrom: [
    "**/*.{ts,js}",
    "!**/node_modules/**",
    "!**/coverage/**",
    "!src/types/**",
    "!lib/**",
    "!jest.config.js",
    "!.yalc/**",
    "!__tests__/**",
  ],
  coveragePathIgnorePatterns: ["/node_modules/"],
};
