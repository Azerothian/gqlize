/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
      module: { type: 'commonjs' },
    }],
  },
  // Resolve sibling workspace packages from source (their published `exports`
  // subpaths only exist after a build).
  moduleNameMapper: {
    '^@azerothian/ormize-adapter-sequelize$': '<rootDir>/../ormize-adapter-sequelize/src/index.ts',
    '^@azerothian/ormize-adapter-sequelize/(.*)$': '<rootDir>/../ormize-adapter-sequelize/src/$1',
    '^@azerothian/utilize$': '<rootDir>/../utilize/src/index.ts',
    '^@azerothian/utilize/(.*)$': '<rootDir>/../utilize/src/$1',
    '^@azerothian/gqlize$': '<rootDir>/../gqlize/src/index.ts',
    '^@azerothian/gqlize/(.*)$': '<rootDir>/../gqlize/src/$1',
    '^@azerothian/graphql-types$': '<rootDir>/../graphql-types/src/index.ts',
    '^@azerothian/graphql-types/(.*)$': '<rootDir>/../graphql-types/src/$1',
  },
  testMatch: ["**/__tests__/**/?(*.)+(spec|test).[jt]s?(x)"],
};
