// The api suite. It runs from the root of the repository: the instrumenter leaves out the files that are outside the root
// directory of the project, and most of the code of `packages/db` and `packages/kernel` is exercised by these tests
// (the stores, through the routes). The coverage of those two packages is judged on all the suites together by
// `npm run coverage:libs`; here the threshold is the one of the sources of the api.
module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/apps/api', '<rootDir>/packages'],
  preset: './jest.preset.cjs',
  setupFiles: ['reflect-metadata'],
  testMatch: ['<rootDir>/apps/api/src/**/*.test.ts', '<rootDir>/apps/api/test/**/*.test.ts'],
  transform: {
    '^.+.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      },
    ],
  },
  maxWorkers: 4,
  workerIdleMemoryLimit: '1500MB',
  globalSetup: '<rootDir>/packages/db/jest.global-setup.mjs',
  globalTeardown: '<rootDir>/packages/db/jest.global-teardown.mjs',
  coverageDirectory: '<rootDir>/apps/api/coverage',
  collectCoverageFrom: ['<rootDir>/apps/api/src/**/*.ts', '<rootDir>/packages/db/src/**/*.ts', '<rootDir>/packages/kernel/src/**/*.ts', '!**/*.test.ts'],
  coverageThreshold: { './src/': { lines: 90 } },
};
