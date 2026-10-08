const path = require('node:path');

const singleParseEntryMessage =
  'Parse through parseOxcCached/parseOxcProgramCached from src/utils/parseOxc.ts: it owns the parse cache, the .js JSX fallback, raw-transfer recovery and parse telemetry.';

module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  ignorePatterns: ['src/__tests__/legacy-babel-reference/**'],
  rules: {
    '@typescript-eslint/member-ordering': 'off',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'oxc-parser',
            importNames: ['parse', 'parseSync'],
            message: singleParseEntryMessage,
          },
        ],
        patterns: [
          {
            group: ['**/parseOxc'],
            importNames: ['parseOxcSync'],
            message: singleParseEntryMessage,
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['src/utils/parseOxc.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      files: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/__tests__/**/*.ts',
        'src/**/__tests__/**/*.tsx',
      ],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          {
            devDependencies: true,
            packageDir: [__dirname, path.resolve(__dirname, '../..')],
          },
        ],
        // Tests compare against reference parses and spy on the raw parser.
        'no-restricted-imports': 'off',
      },
    },
  ],
};
