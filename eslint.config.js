import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Root-level config files live outside tsconfig's `include`.
        projectService: { allowDefaultProject: ['eslint.config.js', 'prisma7.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // The layer rule from the README, enforced by the linter rather than by review.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/config/db.js', '**/generated/prisma/**'],
              importNames: ['prisma', 'PrismaClient'],
              message:
                'Controllers and routes must not touch Prisma directly. Go through a service in src/services/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Services are the only layer allowed to reach the database.
    files: ['src/services/**/*.ts', 'src/config/db.ts', 'src/seed.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
);
