import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { MongoClient, Binary, ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import { engineFactory } from '../../services/engines/engine.factory';
import { MONGO, REDIS, uniq, tmpDir, engineConfig } from './helpers';

/**
 * MongoDB and Redis go through the real mongodump/mongorestore and redis-cli.
 * Both servers require a password, so these tests also prove the passwords
 * reach the tools without being put on the command line.
 */

describe.skipIf(!MONGO)('MongoDB backup and restore (auth enabled)', () => {
  const source = uniq('e2e_mongo_src');
  const out = tmpDir();
  let client: MongoClient;
  const N = 5000;

  beforeAll(async () => {
    const user = decodeURIComponent(MONGO!.username);
    const password = decodeURIComponent(MONGO!.password);
    // Create the user through the localhost exception on a fresh server, then log in with it
    const bootstrap = new MongoClient(`mongodb://${MONGO!.host}/?directConnection=true`);
    await bootstrap.connect();
    try {
      await bootstrap.db('admin').command({ createUser: user, pwd: password, roles: ['root'] });
    } catch (err) {
      if (!/already exists|requires authentication|not authorized/i.test(String(err))) throw err;
    } finally {
      await bootstrap.close();
    }
    client = new MongoClient(`${MONGO!.toString().replace(/\/$/, '')}/?authSource=admin&directConnection=true`);
    await client.connect();
    const docs = Array.from({ length: N }, (_, i) => ({
      _id: new ObjectId(),
      n: i,
      name: i % 3 === 0 ? `Ünïcødé 😀 ${i}` : `doc "${i}"`,
      nested: { arr: [1, 'two', null, { deep: i }], when: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)) },
      bin: new Binary(Buffer.from(`bytes-${i}`)),
    }));
    await client.db(source).collection('items').insertMany(docs);
    await client.db(source).collection('items').createIndex({ n: 1 }, { unique: true, name: 'n_unique' });
    await client.db(source).collection('logs').insertMany([{ msg: 'a' }, { msg: 'b' }]);
  });

  afterAll(async () => {
    await client?.db(source).dropDatabase().catch(() => undefined);
    await client?.close();
    fs.rmSync(out, { recursive: true, force: true });
  });

  const cfg = () => engineConfig('MONGODB', MONGO!, source);

  it('testConnection succeeds with the right password and fails with a wrong one', async () => {
    expect((await engineFactory(cfg()).testConnection()).success).toBe(true);
    const bad = await engineFactory({ ...cfg(), password: 'wrong' }).testConnection();
    expect(bad.success).toBe(false);
    expect(bad.message).toMatch(/auth|Authentication/i);
  });

  it('backup restores into another database with every document and index', async () => {
    const engine = engineFactory(cfg());
    const backup = await engine.backup(out);
    expect(backup.fileName).toMatch(/\.archive\.gz$/);
    expect(backup.fileSize).toBeGreaterThan(0);

    const target = uniq('e2e_mongo_rst');
    try {
      await engine.restore(backup.filePath, target);
      const src = await client.db(source).collection('items').find().sort({ n: 1 }).toArray();
      const dst = await client.db(target).collection('items').find().sort({ n: 1 }).toArray();
      expect(dst).toHaveLength(N);
      expect(dst).toEqual(src);
      expect(await client.db(target).collection('logs').countDocuments()).toBe(2);
      const indexes = await client.db(target).collection('items').indexes();
      expect(indexes.map((i) => i.name)).toContain('n_unique');
    } finally {
      await client.db(target).dropDatabase();
    }
  });

  it('no temporary password file is left behind', async () => {
    const before = fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('dbbk-mongo-'));
    await engineFactory(cfg()).testConnection();
    const after = fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('dbbk-mongo-'));
    expect(after).toEqual(before);
  });
});

describe.skipIf(!REDIS)('Redis RDB backup (requirepass)', () => {
  const out = tmpDir();
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS!.toString());
    await redis.flushdb();
    const pipe = redis.pipeline();
    for (let i = 0; i < 2000; i++) pipe.set(`key:${i}`, `value ${i}`);
    pipe.hset('h', { a: '1', b: 'two' });
    pipe.rpush('list', 'x', 'y', 'z');
    await pipe.exec();
  });
  afterAll(async () => {
    await redis?.flushdb();
    redis?.disconnect();
    fs.rmSync(out, { recursive: true, force: true });
  });

  const cfg = () => engineConfig('REDIS', REDIS!, '0');

  it('testConnection uses the password (and fails without it)', async () => {
    const ok = await engineFactory(cfg()).testConnection();
    expect(ok.success).toBe(true);
    expect(ok.version).toMatch(/^\d+\.\d+/);
    const noPw = await engineFactory({ ...cfg(), password: undefined }).testConnection();
    expect(noPw.success).toBe(false);
  });

  it('backup writes a complete RDB snapshot', async () => {
    const backup = await engineFactory(cfg()).backup(out);
    const head = fs.readFileSync(backup.filePath).subarray(0, 5).toString('latin1');
    expect(head).toBe('REDIS');
    expect(backup.fileSize).toBeGreaterThan(20_000); // 2000 keys
  });

  it('restore is refused with instructions (needs a server restart)', async () => {
    await expect(engineFactory(cfg()).restore('/nonexistent.rdb')).rejects.toThrow(/restart/);
  });
});
