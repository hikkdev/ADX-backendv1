import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
const fileEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Vitest injects Vite's own BASE_URL ("/") into process.env, which collides
    // with the app's BASE_URL setting and fails config/env.ts validation.
    // Re-applying .env here takes precedence over that injection. One key is
    // allowed to win over .env from the shell: REDIS_URL, so the suite can run
    // against the local Docker Redis (docker-compose.yml) when the hosted one
    // is out of quota — `REDIS_URL=redis://localhost:6379 npm run verify`.
    env: { BASE_URL: '', ...fileEnv, ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}) },
    // The Prisma pool and the Redis connection are process-wide singletons, and
    // the route collector may only patch the Express Router prototype once per
    // process, so each file gets its own forked worker and they run one at a time.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
