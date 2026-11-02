import { defineConfig } from 'vitest/config';

// Tests that talk to Postgres through Prisma. Their setup file deletes every
// user, connection and sync row before each test, so they only ever run
// against TEST_DATABASE_URL — never the app's DATABASE_URL.
const integrationTests = [
  'src/controllers/sync-conflict.controller.test.ts',
  'src/services/sync/sync-engine.service.test.ts',
  'src/test/sync/config-roundtrip.property.test.ts',
  'src/test/sync/conflict-resolver.test.ts',
  'src/test/sync/mysql-cdc-tracker.test.ts',
  'src/test/sync/postgresql-cdc-tracker.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/test/',
        '**/*.test.ts',
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...integrationTests, 'src/test/e2e/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationTests,
          setupFiles: ['./src/test/setup.ts'],
          env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' },
          // Tests share one database and wipe it in beforeEach.
          // sync-engine.service.test.ts also enqueues real BullMQ jobs, so it
          // needs a reachable Redis (REDIS_HOST/REDIS_PORT, default :6379).
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          // Real databases and real CLI tools (pg_dump, mariadb-dump, mongodump, redis-cli).
          // Each suite is skipped unless its E2E_* URL is set — see src/test/e2e/README.md.
          name: 'e2e',
          include: ['src/test/e2e/**/*.e2e.test.ts'],
          globalSetup: ['./src/test/e2e/global-setup.ts'],
          env: { DATABASE_URL: process.env.E2E_APP_DATABASE_URL ?? '' },
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
