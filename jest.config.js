module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }]
  },
  setupFilesAfterEach: [],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  moduleNameMapper: {
    '^hereya-cli$': '<rootDir>/test/stubs/hereya-cli.ts'
  }
};
