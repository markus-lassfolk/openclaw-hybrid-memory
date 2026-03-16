import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'scripts/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      // Bug-catching rules — warn so existing code doesn't block CI
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // versionInfo.ts uses createRequire() — warn rather than error
      '@typescript-eslint/no-require-imports': 'warn',

      // Style rules — warn to avoid blocking CI on existing code
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      'no-misleading-character-class': 'warn',
      'no-control-regex': 'warn',

      'no-console': 'off',
    },
  },
)
