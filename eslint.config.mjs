import tseslint from 'typescript-eslint';

/**
 * Architecture-only lint config.
 *
 * This is deliberately NOT a code-quality setup: no `recommended` presets, no
 * style rules. The modular refactor is structure-only, and turning on hundreds
 * of unrelated findings would bury the one thing these rules exist to catch —
 * imports that cross a module boundary in a way the architecture forbids.
 *
 * Division of labour with .dependency-cruiser.cjs: ESLint owns the rules that
 * are about the *shape of the specifier* (reaching into a sibling module),
 * dependency-cruiser owns the rules that are about *resolved file paths*
 * (cycles, shared-imports-business, Prisma outside a repository). Keeping the
 * Prisma rule out of ESLint matters because `no-restricted-imports` options are
 * replaced wholesale by a later matching config block rather than merged, so
 * stacking two blocks over the same files silently disables the first.
 *
 * The rules are expressed against relative specifiers because the project
 * intentionally has no path aliases: the build is plain `tsc` to CommonJS run
 * as `node dist/server.js`, where aliases would not resolve at runtime.
 *
 *   src/modules/<m>/<file>.ts        -> a sibling module is `../<other>`
 *   src/modules/<m>/<sub>/<file>.ts  -> a sibling module is `../../<other>`
 *
 * so "one path segment past the sibling module" is exactly a forbidden deep
 * import, while `shared/` always sits one level further out and is unaffected.
 */

const deepImportMessage =
  'Import another module through its public index (e.g. `../orders`), never a file inside it. See docs/backend-modules.md.';

const sharedMessage =
  'Shared infrastructure must not depend on business modules. Invert the dependency or move the code into the module that owns it.';

/**
 * One config block per module nesting depth.
 *
 * `regex` rather than `group`: group patterns are matched with gitignore
 * semantics, where a pattern with no leading slash matches at ANY depth, so
 * `../*​/*` also matched `../../shared/database` and banned shared imports by
 * accident. An anchored regex says exactly what is meant — climb to the modules
 * directory, enter a sibling whose name is not another `..`, then keep going.
 *
 *   ../orders                 allowed (the sibling's public index)
 *   ../orders/orders.service  forbidden (a file inside the sibling)
 *   ../../shared/http         allowed (not a module at all)
 */
function moduleDepth(files, upwardSegments) {
  const climb = '\\.\\./'.repeat(upwardSegments);
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: `^${climb}[^./][^/]*/`, message: deepImportMessage },
          ],
        },
      ],
    },
  };
}

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

  moduleDepth(['src/modules/*/*.ts'], 1),
  moduleDepth(['src/modules/*/*/*.ts'], 2),
  moduleDepth(['src/modules/*/*/*/*.ts'], 3),

  // Shared infrastructure and config are the bottom of the dependency graph.
  {
    files: ['src/shared/**/*.ts', 'src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)modules/', message: sharedMessage },
          ],
        },
      ],
    },
  },
);
