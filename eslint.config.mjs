import tseslint from 'typescript-eslint';

/**
 * Architecture-only lint config.
 *
 * This is deliberately NOT a code-quality setup: no `recommended` presets, no
 * style rules. The modular refactor is structure-only, and turning on hundreds
 * of unrelated findings would bury the one thing these rules exist to catch —
 * imports that cross a module boundary in a way the architecture forbids.
 *
 * The rules are expressed against relative specifiers because the project
 * intentionally has no path aliases: the build is plain `tsc` to CommonJS run
 * as `node dist/server.js`, where aliases would not resolve at runtime.
 *
 *   src/modules/<m>/<file>.ts          -> a sibling module is `../<other>`
 *   src/modules/<m>/<sub>/<file>.ts    -> a sibling module is `../../<other>`
 *
 * so "one segment past the sibling module" is exactly a forbidden deep import.
 */

const deepImportMessage =
  'Import another module through its public index (e.g. `../orders`), never a file inside it. See docs/backend-modules.md.';

const sharedMessage =
  'Shared infrastructure must not depend on business modules. Invert the dependency or move the code into the module that owns it.';

const prismaMessage =
  'Prisma access belongs in a module repository (prisma-*.repository.ts). Controllers and services must go through the repository interface.';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/generated/**',
      'uploads/**',
      'prisma/**',
      'coverage/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    },
  },

  // A module root file may reach a sibling module's index (`../users`) but
  // never a file inside it (`../users/users.service`).
  {
    files: ['src/modules/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*/*'], message: deepImportMessage }] },
      ],
    },
  },

  // Same rule one directory deeper, for modules split into subfeatures.
  {
    files: ['src/modules/*/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../../*/*'], message: deepImportMessage }] },
      ],
    },
  },

  // Shared infrastructure and config are the bottom of the dependency graph.
  {
    files: ['src/shared/**/*.ts', 'src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/modules/**', '../modules/*', '../../modules/*'], message: sharedMessage }] },
      ],
    },
  },

  // Only repositories may hold the Prisma client. Jobs and scripts are
  // deliberately exempt: they are composition roots, not layered code.
  {
    files: ['src/modules/**/*.ts'],
    ignores: ['src/modules/**/prisma-*.repository.ts', 'src/modules/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/shared/database', '**/shared/database/*'], message: prismaMessage },
            { group: ['../*/*'], message: deepImportMessage },
            { group: ['../../*/*'], message: deepImportMessage },
          ],
        },
      ],
    },
  },
);
