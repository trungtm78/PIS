// The api suite. It runs from the root of the repository: the instrumenter leaves out the files that are outside the root
// directory of the project, and most of the code of `packages/db` and `packages/kernel` is exercised by these tests
// (the stores, through the routes). The coverage of those two packages is judged on all the suites together by
// `npm run coverage:libs`; here the threshold is the one of the sources of the api.
// A UAT run (scripts/uat-run.mjs) sets UAT_JOURNAL: the requests of the tests and the result of each test case are then written to that file.
const uatRun = process.env.UAT_JOURNAL !== undefined && process.env.UAT_JOURNAL !== '';

module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/apps/api', '<rootDir>/packages'],
  preset: './jest.preset.cjs',
  setupFiles: ['reflect-metadata'],
  setupFilesAfterEnv: uatRun ? ['<rootDir>/apps/api/test/support/uat-fetch-setup.ts'] : [],
  reporters: uatRun ? ['default', '<rootDir>/scripts/uat-jest-reporter.mjs'] : ['default'],
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
  // Most cases create a tenant on a real database: the 5 s default of Jest is too short on a slow shared runner (the ARM one failed on it); a case that needs more says so itself.
  testTimeout: 30_000,
  maxWorkers: 4,
  workerIdleMemoryLimit: '1500MB',
  globalSetup: '<rootDir>/packages/db/jest.global-setup.mjs',
  globalTeardown: '<rootDir>/packages/db/jest.global-teardown.mjs',
  coverageDirectory: '<rootDir>/apps/api/coverage',
  collectCoverageFrom: ['<rootDir>/apps/api/src/**/*.ts', '<rootDir>/packages/db/src/**/*.ts', '<rootDir>/packages/kernel/src/**/*.ts', '!**/*.test.ts'],
  coverageThreshold: { './src/': { lines: 90 } },
};
