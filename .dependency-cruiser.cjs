/**
 * Structural rules the ESLint specifier patterns cannot express: cycles, and
 * boundary violations stated in terms of resolved file paths rather than the
 * literal text of an import.
 *
 * Run with `npm run arch`.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'Circular imports make module ownership meaningless and break at runtime under CommonJS, where the second module in the cycle sees a partially initialised export object.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-stays-generic',
      comment:
        'shared/ and config/ are the bottom of the graph. If shared code needs business behaviour, the dependency is inverted: export an interface from shared and implement it in the module.',
      severity: 'error',
      from: { path: '^src/(shared|config)/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-deep-module-import',
      comment:
        'Cross-module imports must go through the module public index. Reaching a file inside another module couples you to its internals.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/.+',
        pathNot: ['^src/modules/$1/', '^src/modules/([^/]+)/index\\.ts$'],
      },
    },
    {
      name: 'prisma-only-in-repositories',
      comment:
        'The Prisma client belongs behind a module repository so controllers and services depend on an interface, not on the ORM. Type-only imports are exempt: generated enum and row types erase at compile time and carry no coupling to the ORM API.',
      severity: 'error',
      from: {
        path: '^src/modules/',
        pathNot: 'prisma-[^/]+\\.repository\\.ts$',
      },
      to: { path: '^src/shared/database', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-orphans',
      comment: 'A file nothing imports is dead weight left behind by the migration.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '^src/(app|server)\\.ts$',
          '^src/scripts/',
          '^src/generated/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^src/generated/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node'] },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
