import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import net from 'net';
import { randomUUID } from 'crypto';
import { Server, utils, type Connection } from 'ssh2';
import { prisma } from '../../config/database';
import { encrypt } from '../../services/crypto.service';
import { toEngineConfig } from '../../services/engines/connection-config';
import { engineFactory } from '../../services/engines/engine.factory';
import { sshFingerprint } from '../../services/ssh.service';
import { PG, APP_DB, uniq, tmpDir, pgCreateDb, pgDropDb, pgAdmin } from './helpers';

/**
 * A real SSH server (ssh2's Server) that accepts one client key and forwards
 * direct-tcpip channels, used to tunnel to the test Postgres. Restarting it
 * with a different host key simulates a reinstalled server or an attacker.
 */
class TestSshServer {
  private server: Server | null = null;
  private clients = new Set<Connection>();
  port = 0;
  forwards: string[] = [];

  constructor(private readonly clientPublicKey: string) {}

  async start(hostKey: string, port = 0): Promise<void> {
    const allowed = utils.parseKey(this.clientPublicKey);
    if (allowed instanceof Error) throw allowed;
    this.server = new Server({ hostKeys: [hostKey] }, (client) => {
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
      client.on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())) {
          if (!ctx.signature) return ctx.accept(); // key check before the signed request
          if (allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
        }
        ctx.reject(['publickey']);
      });
      client.on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          this.forwards.push(`${info.destIP}:${info.destPort}`);
          const channel = accept();
          const upstream = net.connect(info.destPort, info.destIP);
          channel.pipe(upstream).pipe(channel);
          upstream.on('error', () => channel.close());
          channel.on('close', () => upstream.destroy());
        });
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}

const ready = !!(PG && APP_DB);

describe.skipIf(!ready)('SSH tunnel with host key pinning (trust on first use)', () => {
  const clientKey = utils.generateKeyPairSync('ed25519');
  const hostKeyA = utils.generateKeyPairSync('ed25519');
  const hostKeyB = utils.generateKeyPairSync('ed25519');
  const ssh = new TestSshServer(clientKey.public);
  const db = uniq('e2e_ssh_pg');
  const out = tmpDir();
  let userId = '';
  let connectionId = '';

  const expectedFingerprint = (pub: string) => {
    const k = utils.parseKey(pub);
    if (k instanceof Error) throw k;
    return sshFingerprint(k.getPublicSSH());
  };
  const loadConfig = async () => toEngineConfig((await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } })));
  const pinned = async () => (await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } })).sshHostKey;

  beforeAll(async () => {
    await pgCreateDb(db);
    await pgAdmin(db, (c) => c.query("CREATE TABLE t (id int PRIMARY KEY); INSERT INTO t SELECT generate_series(1, 25)"));
    await ssh.start(hostKeyA.private);

    userId = randomUUID();
    connectionId = randomUUID();
    await prisma.user.create({ data: { id: userId, name: 'ssh e2e', email: `${userId}@e2e.test`, passwordHash: 'x' } });
    await prisma.connection.create({
      data: {
        id: connectionId,
        userId,
        name: 'Tunnelled PG',
        type: 'POSTGRESQL',
        // The DB is reached from the SSH server's side
        host: encrypt('127.0.0.1'),
        port: Number(PG!.port),
        username: encrypt(decodeURIComponent(PG!.username)),
        password: encrypt(decodeURIComponent(PG!.password)),
        database: encrypt(db),
        sshEnabled: true,
        sshHost: encrypt('127.0.0.1'),
        sshPort: ssh.port,
        sshUsername: encrypt('tunnel'),
        sshPrivateKey: encrypt(clientKey.private),
      },
    });
  });

  afterAll(async () => {
    await ssh.stop();
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await pgDropDb(db);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('first connect pins the server host key and the backup goes through the tunnel', async () => {
    expect(await pinned()).toBeNull();
    const engine = engineFactory(await loadConfig());
    const r = await engine.testConnection();
    expect(r.success).toBe(true);
    expect(await pinned()).toBe(expectedFingerprint(hostKeyA.public));
    expect(ssh.forwards).toContain(`127.0.0.1:${PG!.port}`);
  });

  it('a backup and restore drill through the tunnel work (one config reused for several tunnels)', async () => {
    const engine = engineFactory(await loadConfig());
    const backup = await engine.backup(out, { format: 'CUSTOM' });
    const scratch = uniq('dbbackup_drill');
    await engine.createDatabase(scratch);
    try {
      await engine.restore(backup.filePath, scratch);
      const counts = await engine.countAllTables(scratch);
      expect(counts).toEqual({ tables: 1, rows: 25n });
    } finally {
      await engine.dropDatabase(scratch);
    }
  });

  it('a different host key is refused, nothing reaches the database, and the pin is kept', async () => {
    await ssh.stop();
    ssh.forwards = [];
    await ssh.start(hostKeyB.private, ssh.port);
    const engine = engineFactory(await loadConfig());
    await expect(engine.backup(out, { format: 'CUSTOM' })).rejects.toThrow(/SSH host key .* has changed/);
    expect(ssh.forwards).toEqual([]);
    expect(await pinned()).toBe(expectedFingerprint(hostKeyA.public));
  });

  it('after "Forget SSH host key" the new key is pinned on the next connect', async () => {
    await prisma.connection.update({ where: { id: connectionId }, data: { sshHostKey: null } });
    const r = await engineFactory(await loadConfig()).testConnection();
    expect(r.success).toBe(true);
    expect(await pinned()).toBe(expectedFingerprint(hostKeyB.public));
  });

  it('a config loaded before the pin changed still checks the current pin', async () => {
    const stale = await loadConfig(); // carries key B
    await prisma.connection.update({ where: { id: connectionId }, data: { sshHostKey: expectedFingerprint(hostKeyA.public) } });
    await expect(engineFactory(stale).testConnection()).rejects.toThrow(/has changed/);
  });
});
