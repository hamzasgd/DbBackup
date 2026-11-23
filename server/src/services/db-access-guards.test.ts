import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response } from 'express';
import { DatabaseType, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';

process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

import { encrypt } from './crypto.service';
import { deleteConnection } from '../controllers/connection.controller';
import { setUserStatus } from '../controllers/admin.controller';
import { findAccess } from './db-gateway/gateway.service';

/** Integration: what the gateway relies on next to its own checks, since each access keeps a database user. */
describe('database access guards', () => {
  const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  type Who = { id: string; email: string; role: UserRole };
  let owner: Who;
  let admin: Who;

  beforeEach(async () => {
    owner = await prisma.user.create({ data: { email: `owner-${tag()}@example.com`, name: 'Owner', passwordHash: 'h' } });
    admin = await prisma.user.create({
      data: { email: `admin-${tag()}@example.com`, name: 'Admin', passwordHash: 'h', role: 'ADMIN' },
    });
  });
  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
  });

  const connection = () => prisma.connection.create({
    data: {
      userId: owner.id, name: 'Shop', type: DatabaseType.MYSQL, host: encrypt('db.example.com'), port: 3306, database: encrypt('shop'),
      username: encrypt('u'), password: encrypt('p'),
    },
  });
  const access = (connectionId: string) => {
    const username = `ali-${tag().slice(-8)}`;
    return prisma.dbAccess.create({
      data: {
        userId: owner.id, connectionId, name: 'Ali', username, hashNative: '00'.repeat(20), hashSha2: '00'.repeat(32), database: 'shop',
        tables: [], privileges: ['SELECT'], maxConnections: 5, backendUser: 'dbb_stand_in', backendHost: '%', backendPassword: encrypt('p'),
      },
      select: { username: true },
    });
  };
  const req = (user: Who, body: object = {}, params: object = {}) =>
    ({ user: { userId: user.id, email: user.email, role: user.role }, body, params, query: {}, ip: '127.0.0.1', headers: {} }) as unknown as AuthRequest;
  async function run(handler: (rq: AuthRequest, rs: Response, nx: () => void) => Promise<void>, rq: AuthRequest) {
    const r = { json: vi.fn(), status: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    r.status.mockReturnValue(r);
    const next = vi.fn();
    await handler(rq, r, next);
    return { r, err: next.mock.calls[0]?.[0] };
  }

  it('does not delete a connection while accesses on it keep database users', async () => {
    const c = await connection();
    await access(c.id);
    const refused = await run(deleteConnection, req(owner, {}, { id: c.id }));
    expect(refused.err).toMatchObject({ statusCode: 409, code: 'HAS_DB_ACCESS' });
    expect(await prisma.connection.count({ where: { id: c.id } })).toBe(1);
    expect(await prisma.dbAccess.count({ where: { connectionId: c.id } })).toBe(1);

    // Once the access is removed on the page (which drops its database user), the connection can go
    await prisma.dbAccess.deleteMany({ where: { connectionId: c.id } });
    const gone = await run(deleteConnection, req(owner, {}, { id: c.id }));
    expect(gone.err).toBeUndefined();
    expect(await prisma.connection.count({ where: { id: c.id } })).toBe(0);
  });

  it('finds no access for the gateway login once its owner is suspended', async () => {
    const c = await connection();
    const { username } = await access(c.id);
    expect(await findAccess(username)).toMatchObject({ username, database: 'shop' });

    await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });
    expect(await findAccess(username)).toBeNull();
    expect(await findAccess('nobody')).toBeNull();
  });

  it('suspends an account that gave database access without failing', async () => {
    const c = await connection();
    await access(c.id);
    const { err } = await run(setUserStatus, req(admin, { isActive: false }, { id: owner.id }));
    expect(err).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toMatchObject({ isActive: false });
  });
});
