import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../config/database';

// vitest.config.ts maps TEST_DATABASE_URL onto DATABASE_URL for this project.
// This setup wipes tables, so refuse to run without a dedicated test database.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'Integration tests need a disposable Postgres database. Set TEST_DATABASE_URL ' +
    '(e.g. postgresql://postgres:postgres@localhost:5432/dbbackup_test), run ' +
    '`npx prisma migrate deploy` against it, then `npm run test:integration`. ' +
    'WARNING: every table used by the tests is emptied before each test.'
  );
}

beforeAll(async () => {
  // Connect to test database
  await prisma.$connect();
});

afterAll(async () => {
  // Disconnect from test database
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean up test data before each test
  // This ensures tests are isolated
  // Delete in order of dependencies (children first, then parents)
  await prisma.syncHistory.deleteMany();
  await prisma.conflict.deleteMany();
  await prisma.changeLog.deleteMany();
  await prisma.syncState.deleteMany();
  await prisma.syncConfiguration.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
});
