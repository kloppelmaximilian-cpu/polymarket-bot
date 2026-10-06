import { defineConfig } from 'vitest/config';

/**
 * Three projects so the fast feedback loop stays fast:
 *   unit         pure logic, no database, no network
 *   db           PGlite (Postgres compiled to WASM) with the real migrations
 *   integration  whole pipeline, API, jobs; PGlite by default, real Postgres
 *                when TEST_DATABASE_URL is set
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'strategies/*/test/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['packages/*/test/**/*.db.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/api/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
