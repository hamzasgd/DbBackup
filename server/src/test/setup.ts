import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../config/database';

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
