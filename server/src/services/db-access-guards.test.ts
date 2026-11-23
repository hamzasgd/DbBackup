import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response } from 'express';
import { DatabaseType, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';

process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

import { encrypt } from './crypto.service';
import { deleteConnection } from '../controllers/connection.controller';
import { setUserStatus } from '../controllers/admin.controller';
import { findAccess, usableAccesses } from './db-gateway/gateway.service';

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
  const access = (connectionId: string, privileges = ['SELECT']) => {
    const username = `ali-${tag().slice(-8)}`;
    return prisma.dbAccess.create({
      data: {
        userId: owner.id, connectionId, name: 'Ali', username, hashNative: '00'.repeat(20), hashSha2: '00'.repeat(32), database: 'shop',
        tables: [], privileges, maxConnections: 5, backendUser: 'dbb_stand_in', backendHost: '%', backendPassword: encrypt('p'),
      },
      select: { id: true, username: true },
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

  it('keeps sessions off accesses that are off, expired, suspended, or that write where nobody may write', async () => {
    const c = await connection();
    const read = (await access(c.id)).id;
    const write = (await access(c.id, ['SELECT', 'UPDATE'])).id;
    expect(await usableAccesses([read, write])).toEqual(new Set([read, write]));

    // Write protection turned on after the accesses were made
    await prisma.connection.update({ where: { id: c.id }, data: { writeProtected: true } });
    expect(await usableAccesses([read, write])).toEqual(new Set([read]));
    await prisma.connection.update({ where: { id: c.id }, data: { writeProtected: false } });

    // A live sync started later, into the same connection
    await prisma.liveSync.create({
      data: { userId: owner.id, targetConnectionId: c.id, sourceName: 'Copy', targetName: 'Shop', sourceDatabase: 'shop', targetDatabase: 'shop', serverId: 1 },
    });
    expect(await usableAccesses([read, write])).toEqual(new Set([read]));
    await prisma.liveSync.updateMany({ where: { targetConnectionId: c.id }, data: { enabled: false } });
    expect(await usableAccesses([read, write])).toEqual(new Set([read, write]));

    // Off, in the past, or removed
    await prisma.dbAccess.update({ where: { id: read }, data: { enabled: false } });
    expect(await usableAccesses([read, write])).toEqual(new Set([write]));
    await prisma.dbAccess.update({ where: { id: write }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await usableAccesses([read, write])).toEqual(new Set());
    await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });
    await prisma.dbAccess.updateMany({ where: { connectionId: c.id }, data: { enabled: true, expiresAt: null } });
    expect(await usableAccesses([read, write])).toEqual(new Set());
  });

  it('suspends an account that gave database access without failing', async () => {
    const c = await connection();
    await access(c.id);
    const { err } = await run(setUserStatus, req(admin, { isActive: false }, { id: owner.id }));
    expect(err).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toMatchObject({ isActive: false });
  });
});
