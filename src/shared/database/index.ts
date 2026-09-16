/**
 * The single door to the database.
 *
 * Beyond the shared client, this re-exports the generated Prisma client so no
 * other file has to name `src/generated/prisma` by relative path. That matters
 * here specifically: the project has no path aliases (plain tsc -> CommonJS,
 * run as `node dist/server.js`, where aliases would not resolve), so every
 * `../../generated/prisma` specifier is depth-sensitive and breaks the moment
 * a file moves. Importing model types from `shared/database` instead makes
 * module code movable.
 *
 * Model types should be imported with `import type`, which erases at compile
 * time and costs nothing at runtime.
 */
export { closeDatabase, prisma } from './prisma';
export { pingDatabase } from './ping';
export * from '../../generated/prisma';
