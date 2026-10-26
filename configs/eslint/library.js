const noRestrictedSyntax =
  // eslint-disable-next-line import/no-extraneous-dependencies
  require('eslint-config-airbnb-base/rules/style').rules[
    'no-restricted-syntax'
    ].filter(
    (rule) => typeof rule === 'string' || rule.selector !== 'ForOfStatement'
  );

// Workaround for https://github.com/import-js/eslint-plugin-import/issues/1810
const noUnresolved = ['error', { ignore: ['@wyw-in-js/*'] }];

const memberOrder = [
  'warn',
  {
    default: {
      memberTypes: [
        // Index signature
        'signature',
        'call-signature',

        // Fields
        'public-static-field',
        'protected-static-field',
        'private-static-field',
        '#private-static-field',

        'public-decorated-field',
        'protected-decorated-field',
        'private-decorated-field',

        'public-instance-field',
        'protected-instance-field',
        'private-instance-field',
        '#private-instance-field',

        'public-abstract-field',
        'protected-abstract-field',

        'public-field',
        'protected-field',
        'private-field',
        '#private-field',

        'static-field',
        'instance-field',
        'abstract-field',

        'decorated-field',

        'field',

        // Static initialization
        'static-initialization',

        // Constructors
        'public-constructor',
        'protected-constructor',
        'private-constructor',

        'constructor',

        // Getters & Setters
        ['public-static-get', 'public-static-set'],
        ['protected-static-get', 'protected-static-set'],
        ['private-static-get', 'private-static-set'],
        ['#private-static-get', '#private-static-set'],

        ['public-decorated-get', 'public-decorated-set'],
        ['protected-decorated-get', 'protected-decorated-set'],
        ['private-decorated-get', 'private-decorated-set'],

        ['public-instance-get', 'public-instance-set'],
        ['protected-instance-get', 'protected-instance-set'],
        ['private-instance-get', 'private-instance-set'],
        ['#private-instance-get', '#private-instance-set'],

        ['public-abstract-get', 'public-abstract-set'],
        ['protected-abstract-get', 'protected-abstract-set'],

        ['public-get', 'public-set'],
        ['protected-get', 'protected-set'],
        ['private-get', 'private-set'],
        ['#private-get', '#private-set'],

        ['static-get', 'static-set'],
        ['instance-get', 'instance-set'],
        ['abstract-get', 'abstract-set'],

        ['decorated-get', 'decorated-set'],

        ['get', 'set'],

        // Methods
        'public-static-method',
        'protected-static-method',
        'private-static-method',
        '#private-static-method',

        'public-decorated-method',
        'protected-decorated-method',
        'private-decorated-method',

        'public-instance-method',
        'protected-instance-method',
        'private-instance-method',
        '#private-instance-method',

        'public-abstract-method',
        'protected-abstract-method',

        'public-method',
        'protected-method',
        'private-method',
        '#private-method',

        'static-method',
        'instance-method',
        'abstract-method',

        'decorated-method',

        'method',
      ],
      order: 'alphabetically',
    },
  },
];

const importOrder = [
  'warn',
  {
    'newlines-between': 'always',
    alphabetize: {
      order: 'asc',
    },
    groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
    pathGroups: [
      {
        pattern: '@wyw-in-js/**',
        group: 'internal',
        position: 'before',
      },
    ],
    pathGroupsExcludedImportTypes: [],
  },
];

module.exports = {
  globals: {
    JSX: 'readonly',
  },
  ignorePatterns: [
    "/.next",
    "/dist",
    "/esm",
    "/lib",
    "/types",
    "**/__fixtures__/**",
    "**/node_modules/**",
  ],
  overrides: [
    {
      extends: [
        'airbnb-base',
        'airbnb-typescript/base',
        'plugin:@typescript-eslint/recommended',
        'prettier',
        'plugin:prettier/recommended',
        'plugin:import/recommended',
        'plugin:import/typescript',
      ],
      files: ['*.ts', '*.tsx'],
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
      rules: {
        '@typescript-eslint/ban-ts-comment': 0,
        '@typescript-eslint/comma-dangle': 0,
        '@typescript-eslint/consistent-type-imports': [
          'error',
          {prefer: 'type-imports'},
        ],
        '@typescript-eslint/member-ordering': memberOrder,
        '@typescript-eslint/no-non-null-assertion': 0,
        '@typescript-eslint/no-var-requires': 0,
        'global-require': 0,

        // airbnb-typescript/base still enables two rules that typescript-eslint 8
        // removed; enforce the same checks under the names that replace them
        '@typescript-eslint/lines-between-class-members': 0,
        '@typescript-eslint/no-throw-literal': 0,
        '@typescript-eslint/only-throw-error': 'error',
        'lines-between-class-members': [
          'error',
          'always',
          {exceptAfterSingleLine: false},
        ],

        // TODO
        'import/extensions': 0,
        'import/no-dynamic-require': 0,
        'import/prefer-default-export': 0,
        'no-plusplus': ['error', {allowForLoopAfterthoughts: true}],
        'no-restricted-syntax': noRestrictedSyntax,
        'no-underscore-dangle': 0,
      },
    },
    {
      files: ['**/processors/**/*.ts'],
      rules: {},
    },
    {
      extends: [
        'airbnb-base',
        'plugin:prettier/recommended',
        'plugin:import/recommended',
      ],
      files: ['*.js', '*.jsx'],
      parser: '@babel/eslint-parser',
      parserOptions: {
        requireConfigFile: false,
      },
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          {
            devDependencies: [
              'babel.config.js',
              '**/*.test.{js,ts,jsx,tsx}',
              'src/{babel,server}/**/*.{js,ts,jsx,tsx}',
            ],
          },
        ],
      },
    },
    {
      files: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__utils__/**/*.ts',
      ],
      rules: {
        '@typescript-eslint/naming-convention': [
          'error',
          {
            selector: 'variable',
            format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          },
          {
            selector: 'function',
            leadingUnderscore: 'allow',
            format: ['camelCase', 'PascalCase'],
          },
          {
            selector: 'typeLike',
            format: ['PascalCase'],
          },
        ],
        '@typescript-eslint/no-explicit-any': 0,
        '@typescript-eslint/no-non-null-assertion': 0,
        '@typescript-eslint/no-var-requires': 0,
        '@typescript-eslint/no-require-imports': 0,
        'global-require': 0,
        'no-template-curly-in-string': 0,
      },
    },
  ],
  plugins: ['prettier', 'import'],
  rules: {
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: [
          'babel.config.js',
          '**/*.test.{js,ts,jsx,tsx}',
          'src/{babel,server}/**/*.{js,ts,jsx,tsx}',
        ],
      },
    ],
    'import/no-unresolved': noUnresolved,
    'import/order': importOrder,
    'max-len': [
      'error',
      150,
      2,
      {
        ignoreComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
      },
    ],
    'prettier/prettier': 'error',
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
      },
    },
  },
};
