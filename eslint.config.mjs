import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
    {
        ignores: [
            '**/lib/**',
            '**/dist/**',
            '**/package/**',
            '**/__data__/**',
            '**/generated*',
            '**/*.js',
            '**/*.mjs',
            '**/*.d.ts',
            'node_modules/**',
            'dev-server/**',
            'e2e-common/**',
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    eslintConfigPrettier,
    {
        plugins: {
            import: importPlugin,
        },
        languageOptions: {
            parserOptions: {
                project: true,
                sourceType: 'module',
            },
        },
        rules: {
            // TypeScript rules (ported from Vendure core)
            '@typescript-eslint/adjacent-overload-signatures': 'error',
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                },
            ],
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/consistent-type-assertions': 'error',
            '@typescript-eslint/consistent-type-definitions': 'off',
            '@typescript-eslint/dot-notation': 'error',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-member-accessibility': [
                'off',
                {
                    accessibility: 'explicit',
                },
            ],
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/member-ordering': 'off',
            '@typescript-eslint/naming-convention': 'off',
            '@typescript-eslint/no-array-constructor': 'error',
            '@typescript-eslint/no-empty-function': 'error',
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-extra-non-null-assertion': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-for-in-array': 'error',
            '@typescript-eslint/no-implied-eval': 'error',
            '@typescript-eslint/no-inferrable-types': [
                'error',
                {
                    ignoreParameters: true,
                },
            ],
            '@typescript-eslint/no-misused-new': 'error',
            '@typescript-eslint/no-misused-promises': 'warn',
            '@typescript-eslint/no-namespace': 'error',
            '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-shadow': [
                'error',
                {
                    hoist: 'all',
                },
            ],
            '@typescript-eslint/no-this-alias': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/no-unnecessary-type-constraint': 'error',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            '@typescript-eslint/no-unsafe-unary-minus': 'off',
            '@typescript-eslint/no-redundant-type-constituents': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/prefer-promise-reject-errors': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-unused-expressions': 'error',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-use-before-define': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/prefer-as-const': 'error',
            '@typescript-eslint/prefer-for-of': 'error',
            '@typescript-eslint/prefer-function-type': 'error',
            '@typescript-eslint/prefer-namespace-keyword': 'error',
            '@typescript-eslint/require-await': 'warn',
            '@typescript-eslint/restrict-plus-operands': 'error',
            '@typescript-eslint/restrict-template-expressions': 'error',
            '@typescript-eslint/triple-slash-reference': [
                'error',
                {
                    path: 'always',
                    types: 'prefer-import',
                    lib: 'always',
                },
            ],
            '@typescript-eslint/typedef': 'off',
            '@typescript-eslint/unbound-method': 'error',
            '@typescript-eslint/unified-signatures': 'error',

            // Core ESLint rules
            'constructor-super': 'error',
            eqeqeq: ['error', 'smart'],
            'guard-for-in': 'error',
            'max-len': [
                'error',
                {
                    code: 170,
                },
            ],
            'new-parens': 'error',
            'no-array-constructor': 'off',
            'no-bitwise': 'error',
            'no-caller': 'error',
            'no-cond-assign': 'error',
            'no-console': 'error',
            'no-debugger': 'error',
            'no-empty': 'error',
            'no-empty-function': 'off',
            'no-eval': 'error',
            'no-fallthrough': 'error',
            'no-implied-eval': 'off',
            'no-invalid-this': 'off',
            'no-new-wrappers': 'error',
            'no-shadow': 'off',
            'no-throw-literal': 'error',
            'no-undef-init': 'error',
            'no-underscore-dangle': 'off',
            'no-unsafe-finally': 'error',
            'no-unused-expressions': 'off',
            'no-unused-labels': 'error',
            'no-unused-vars': 'off',
            'no-use-before-define': 'off',
            'no-var': 'error',
            'object-shorthand': 'error',
            'one-var': ['error', 'never'],
            'prefer-const': 'error',
            radix: 'error',
            'require-await': 'off',
            'spaced-comment': [
                'error',
                'always',
                {
                    markers: ['/'],
                },
            ],
            'use-isnan': 'error',

            // Import ordering
            'import/order': [
                'warn',
                {
                    alphabetize: {
                        caseInsensitive: true,
                        order: 'asc',
                    },
                    'newlines-between': 'always',
                    groups: [
                        ['builtin', 'external', 'internal', 'unknown', 'object', 'type'],
                        'parent',
                        ['sibling', 'index'],
                    ],
                    distinctGroup: false,
                    pathGroupsExcludedImportTypes: [],
                    pathGroups: [
                        {
                            pattern: './',
                            patternOptions: {
                                nocomment: true,
                                dot: true,
                            },
                            group: 'sibling',
                            position: 'before',
                        },
                        {
                            pattern: '.',
                            patternOptions: {
                                nocomment: true,
                                dot: true,
                            },
                            group: 'sibling',
                            position: 'before',
                        },
                        {
                            pattern: '..',
                            patternOptions: {
                                nocomment: true,
                                dot: true,
                            },
                            group: 'parent',
                            position: 'before',
                        },
                        {
                            pattern: '../',
                            patternOptions: {
                                nocomment: true,
                                dot: true,
                            },
                            group: 'parent',
                            position: 'before',
                        },
                    ],
                },
            ],
        },
    },
);
