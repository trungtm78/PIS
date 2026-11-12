// A UAT run (scripts/uat-run.mjs) sets UAT_JOURNAL: the result of each test case is then written to that file.
const uatRun = process.env.UAT_JOURNAL !== undefined && process.env.UAT_JOURNAL !== '';

module.exports = {
  preset: '../../jest.preset.cjs',
  reporters: uatRun ? ['default', '<rootDir>/../../scripts/uat-jest-reporter.mjs'] : ['default'],
  coverageThreshold: {},
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/test/**/*.test.ts'],
  maxWorkers: 4,
  globalSetup: '<rootDir>/jest.global-setup.mjs',
  globalTeardown: '<rootDir>/jest.global-teardown.mjs',
};
