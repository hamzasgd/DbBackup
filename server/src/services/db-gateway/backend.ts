import net from 'net';
import tls from 'tls';
import type { Duplex } from 'stream';
import { PacketChannel } from './channel';
import {
  CLIENT, SESSION_CAPS, Reader, lenencBytes, nativeToken, parseErr, rsaPassword, sha2Token,
} from './protocol';

export interface BackendLogin {
  user: string;
  password: string;
  database: string | null;
  /** The capability flags the client and the gateway agreed on */
  clientCaps: number;
  charset: number;
  maxPacket: number;
  /** TLS to the database, or undefined for a plain connection */
  tls?: tls.ConnectionOptions;
  attrs?: Record<string, string>;
  /** The socket runs inside an SSH tunnel, so the way to the database is protected by its host key, not by TLS */
  tunnelled?: boolean;
  /** Ask an unprotected database for its public key anyway (DB_GATEWAY_ALLOW_SERVER_PUBLIC_KEY, a private network only) */
  allowServerPublicKey?: boolean;
}

export interface BackendSession {
  stream: Duplex;
  /** Bytes the database sent after its OK packet */
  leftover: Buffer;
  /** The database's OK packet (the client gets it too) */
  ok: Buffer;
  serverVersion: string;
  threadId: number;
  isMariaDB: boolean;
}

export class BackendError extends Error {
  /** `forClient`: the reason is the client's to act on (its driver asked for something the database lacks), so it may be shown to them */
  constructor(message: string, readonly code = 2013, readonly sqlState = 'HY000', readonly forClient = false) {
    super(message);
  }
}

interface ServerHello {
  version: string;
  threadId: number;
  scramble: Buffer;
  caps: number;
  plugin: string;
}

function parseServerHello(payload: Buffer): ServerHello {
  if (payload[0] === 0xff) {
    const e = parseErr(payload);
    throw new BackendError(`The database refused the connection: ${e.message}`, e.code, e.sqlState);
  }
  const r = new Reader(payload);
  if (r.u8() !== 10) throw new BackendError('The database speaks an unsupported protocol version');
  const version = r.nulString();
  const threadId = r.u32();
  const part1 = r.bytes(8);
  r.u8();
  let caps = r.u16();
  r.u8(); // charset
  r.u16(); // status
  caps |= r.u16() << 16;
  const authLen = r.u8();
  r.bytes(10);
  const part2 = r.bytes(Math.max(13, authLen - 8));
  const scramble = Buffer.concat([part1, part2]).subarray(0, 20);
  const plugin = caps & CLIENT.PLUGIN_AUTH ? r.nulString() : 'mysql_native_password';
  return { version, threadId, scramble, caps: caps >>> 0, plugin };
}

function authAnswer(plugin: string, password: string, scramble: Buffer, secure: boolean): Buffer {
  switch (plugin) {
    case 'mysql_native_password':
      return nativeToken(password, scramble);
    case 'caching_sha2_password':
      return sha2Token(password, scramble);
    case 'mysql_clear_password':
      if (!secure) throw new BackendError('The database asked for the password in clear text over an unencrypted connection');
      return Buffer.from(`${password}\0`, 'utf8');
    default:
      throw new BackendError(`The database uses the ${plugin} login method, which the gateway does not support`);
  }
}

/**
 * Log in to the database on an open socket, with the capability flags the
 * client chose, so that packets can then be passed through unchanged.
 */
export async function loginBackend(socket: net.Socket, o: BackendLogin): Promise<BackendSession> {
  const ch = new PacketChannel(socket);
  let stream: Duplex = socket;
  try {
    const hello = parseServerHello((await ch.next()).payload);
    const missing = o.clientCaps & SESSION_CAPS & ~hello.caps;
    if (missing) {
      throw new BackendError(
        `The database does not support what the client asked for (flags 0x${missing.toString(16)}). Try another client or driver version.`,
        2013, 'HY000', true,
      );
    }

    let caps = (o.clientCaps & SESSION_CAPS) |
      CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH |
      CLIENT.PLUGIN_AUTH_LENENC | CLIENT.CONNECT_ATTRS;
    if (o.database) caps |= CLIENT.CONNECT_WITH_DB;
    caps &= hello.caps | CLIENT.SSL;
    const isMariaDB = /mariadb/i.test(hello.version);
    // MariaDB does not know MySQL 8's utf8mb4_0900_ai_ci
    const charset = isMariaDB && o.charset > 250 ? 45 : o.charset;

    const fixed = (flags: number) => {
      const b = Buffer.alloc(32);
      b.writeUInt32LE(flags >>> 0, 0);
      b.writeUInt32LE(o.maxPacket || 0x1000000, 4);
      b[8] = charset;
      return b;
    };

    let seq = 1;
    if (o.tls) {
      if (!(hello.caps & CLIENT.SSL)) throw new BackendError('SSL is on for this connection but the database does not offer it');
      caps |= CLIENT.SSL;
      ch.write(seq++, fixed(caps));
      const raw = ch.pauseForTls();
      const secure = tls.connect({ ...o.tls, socket: raw });
      stream = secure;
      // A database that takes the start of TLS and then falls silent must not hold this login for good
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BackendError('The database did not finish its side of the TLS handshake')), 15_000);
        const up = () => {
          clearTimeout(timer);
          secure.off('error', down);
          secure.off('close', down);
          resolve();
        };
        const down = (e?: Error) => {
          clearTimeout(timer);
          reject(e ?? new BackendError('The TLS connection to the database was closed'));
        };
        secure.once('secureConnect', up);
        secure.once('error', down);
        secure.once('close', down);
      });
      ch.use(secure);
    }
    const secureLink = !!o.tls;

    let plugin = hello.plugin;
    let scramble = hello.scramble;
    const attrs = Object.entries(o.attrs ?? {}).map(([k, v]) => Buffer.concat([lenencBytes(k), lenencBytes(v)]));
    const attrBlock = Buffer.concat(attrs);
    const parts = [
      fixed(caps),
      Buffer.from(`${o.user}\0`, 'utf8'),
      lenencBytes(authAnswer(plugin, o.password, scramble, secureLink)),
    ];
    if (caps & CLIENT.CONNECT_WITH_DB) parts.push(Buffer.from(`${o.database}\0`, 'utf8'));
    parts.push(Buffer.from(`${plugin}\0`, 'utf8'));
    if (caps & CLIENT.CONNECT_ATTRS) parts.push(lenencBytes(attrBlock));
    ch.write(seq++, Buffer.concat(parts));

    for (;;) {
      const p = await ch.next();
      seq = p.seq + 1;
      const kind = p.payload[0];
      if (kind === 0x00) {
        return { stream, leftover: ch.detach(), ok: p.payload, serverVersion: hello.version, threadId: hello.threadId, isMariaDB };
      }
      if (kind === 0xff) {
        const e = parseErr(p.payload);
        throw new BackendError(`The database refused the gateway's login: ${e.message}`, e.code, e.sqlState);
      }
      if (kind === 0xfe) {
        // Switch to another login method
        const r = new Reader(p.payload);
        r.u8();
        plugin = r.nulString();
        const data = r.restBytes();
        scramble = data[data.length - 1] === 0 ? data.subarray(0, data.length - 1) : data;
        ch.write(seq, authAnswer(plugin, o.password, scramble, secureLink));
        continue;
      }
      if (kind === 0x01 && plugin === 'caching_sha2_password') {
        if (p.payload[1] === 0x03) continue; // fast login worked; the OK follows
        if (p.payload[1] === 0x04) {
          // The full check: the password itself. Inside TLS it goes as it is
          if (o.tls) {
            ch.write(seq, Buffer.from(`${o.password}\0`));
            continue;
          }
          // Without TLS it could only go RSA-encrypted to whatever key the database sends, and nobody checks
          // that key: a machine on the way gives its own and reads the password. So only inside an SSH tunnel
          // (the database is vouched for by the host key), or when the operator said the network is private
          if (!o.tunnelled && !o.allowServerPublicKey) {
            throw new BackendError(
              'The database asked for the full password check over an unencrypted connection. '
              + 'Turn on SSL for this connection, or reach the database through its SSH tunnel.',
            );
          }
          ch.write(seq, Buffer.from([0x02]));
          const key = await ch.next();
          ch.write(key.seq + 1, rsaPassword(o.password, scramble, key.payload.subarray(1)));
          continue;
        }
      }
      throw new BackendError(`Unexpected reply from the database during login (0x${kind.toString(16)})`);
    }
  } catch (e) {
    ch.detach();
    stream.destroy();
    socket.destroy();
    if (e instanceof BackendError) throw e;
    throw new BackendError(`Could not log in to the database: ${(e as Error).message}`);
  }
}
