/**
 * The parts of the MySQL client/server protocol the gateway needs: packet
 * framing, the handshake packets of both sides, and the two password checks
 * (mysql_native_password and caching_sha2_password).
 *
 * Written from the protocol documentation
 * (https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html).
 */
import crypto from 'crypto';

export const CLIENT = {
  LONG_PASSWORD: 0x1,
  FOUND_ROWS: 0x2,
  LONG_FLAG: 0x4,
  CONNECT_WITH_DB: 0x8,
  NO_SCHEMA: 0x10,
  COMPRESS: 0x20,
  ODBC: 0x40,
  LOCAL_FILES: 0x80,
  IGNORE_SPACE: 0x100,
  PROTOCOL_41: 0x200,
  INTERACTIVE: 0x400,
  SSL: 0x800,
  TRANSACTIONS: 0x2000,
  SECURE_CONNECTION: 0x8000,
  MULTI_STATEMENTS: 0x10000,
  MULTI_RESULTS: 0x20000,
  PS_MULTI_RESULTS: 0x40000,
  PLUGIN_AUTH: 0x80000,
  CONNECT_ATTRS: 0x100000,
  PLUGIN_AUTH_LENENC: 0x200000,
  SESSION_TRACK: 0x800000,
  DEPRECATE_EOF: 0x1000000,
} as const;

/**
 * What the gateway offers clients. Left out on purpose: compression (the
 * gateway reads every command), LOAD DATA LOCAL (the server could ask for any
 * file on the client's machine), query attributes and optional result
 * metadata (they change packet layouts), multi-factor auth and expired
 * passwords.
 */
export const GATEWAY_CAPS =
  CLIENT.LONG_PASSWORD | CLIENT.FOUND_ROWS | CLIENT.LONG_FLAG | CLIENT.CONNECT_WITH_DB | CLIENT.ODBC |
  CLIENT.IGNORE_SPACE | CLIENT.PROTOCOL_41 | CLIENT.INTERACTIVE | CLIENT.TRANSACTIONS | CLIENT.SECURE_CONNECTION |
  CLIENT.MULTI_STATEMENTS | CLIENT.MULTI_RESULTS | CLIENT.PS_MULTI_RESULTS | CLIENT.PLUGIN_AUTH |
  CLIENT.CONNECT_ATTRS | CLIENT.PLUGIN_AUTH_LENENC | CLIENT.SESSION_TRACK | CLIENT.DEPRECATE_EOF;

/**
 * Flags that change what packets look like after login. The database behind
 * the gateway must agree on every one the client chose, because packets are
 * passed through unchanged.
 */
export const SESSION_CAPS =
  CLIENT.FOUND_ROWS | CLIENT.LONG_FLAG | CLIENT.ODBC | CLIENT.IGNORE_SPACE | CLIENT.PROTOCOL_41 |
  CLIENT.INTERACTIVE | CLIENT.TRANSACTIONS | CLIENT.MULTI_STATEMENTS | CLIENT.MULTI_RESULTS |
  CLIENT.PS_MULTI_RESULTS | CLIENT.SESSION_TRACK | CLIENT.DEPRECATE_EOF;

export const COM = {
  QUIT: 0x01,
  INIT_DB: 0x02,
  QUERY: 0x03,
  FIELD_LIST: 0x04,
  CREATE_DB: 0x05,
  DROP_DB: 0x06,
  REFRESH: 0x07,
  SHUTDOWN: 0x08,
  STATISTICS: 0x09,
  PROCESS_INFO: 0x0a,
  CONNECT: 0x0b,
  PROCESS_KILL: 0x0c,
  DEBUG: 0x0d,
  PING: 0x0e,
  TIME: 0x0f,
  DELAYED_INSERT: 0x10,
  CHANGE_USER: 0x11,
  BINLOG_DUMP: 0x12,
  TABLE_DUMP: 0x13,
  CONNECT_OUT: 0x14,
  REGISTER_SLAVE: 0x15,
  STMT_PREPARE: 0x16,
  STMT_EXECUTE: 0x17,
  STMT_SEND_LONG_DATA: 0x18,
  STMT_CLOSE: 0x19,
  STMT_RESET: 0x1a,
  SET_OPTION: 0x1b,
  STMT_FETCH: 0x1c,
  DAEMON: 0x1d,
  BINLOG_DUMP_GTID: 0x1e,
  RESET_CONNECTION: 0x1f,
  CLONE: 0x20,
} as const;

/** Commands the gateway never passes on: another login, replication, server control */
export const BLOCKED_COMMANDS = new Set<number>([
  COM.CHANGE_USER, COM.BINLOG_DUMP, COM.BINLOG_DUMP_GTID, COM.REGISTER_SLAVE, COM.TABLE_DUMP,
  COM.CONNECT_OUT, COM.SHUTDOWN, COM.DEBUG, COM.DAEMON, COM.CONNECT, COM.DELAYED_INSERT, COM.CLONE,
  COM.REFRESH, COM.CREATE_DB, COM.DROP_DB,
]);

export const MAX_PAYLOAD = 0xffffff;

export interface Packet {
  seq: number;
  payload: Buffer;
}

/** One packet on the wire: 3-byte length, sequence id, payload (at most 16 MiB - 1). */
export function encodePacket(seq: number, payload: Buffer): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error('packet too large to build');
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head[3] = seq & 0xff;
  return Buffer.concat([head, payload]);
}

/**
 * Splits a byte stream into packets. The pieces of a packet that arrives in
 * many small reads are kept aside and joined once, when it is whole: copying
 * after every piece would cost about 96 GB of copying for one 16 MiB packet
 * in 1460-byte pieces, all of it on the main thread.
 */
export class PacketSplitter {
  /** Pieces of the packet that is not whole yet */
  private pieces: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxLength: number = MAX_PAYLOAD) {}

  push(data: Buffer): Packet[] {
    const out: Packet[] = [];
    // Where the next packet starts in data
    let at = 0;
    for (;;) {
      const have = this.size + data.length - at;
      if (have < 4) break;
      const len = this.byteAt(0, data, at) | (this.byteAt(1, data, at) << 8) | (this.byteAt(2, data, at) << 16);
      if (len > this.maxLength) throw new Error(`a packet of ${len} bytes is longer than the ${this.maxLength} allowed`);
      if (have < 4 + len) break;
      // The pieces kept aside are already the first `size` bytes of this packet
      const end = at + 4 + len - this.size;
      const whole = this.size ? Buffer.concat([...this.pieces, data.subarray(at, end)]) : data.subarray(at, end);
      this.pieces = [];
      this.size = 0;
      out.push({ seq: whole[3], payload: whole.subarray(4) });
      at = end;
    }
    if (at < data.length) {
      this.pieces.push(data.subarray(at));
      this.size += data.length - at;
    }
    return out;
  }

  /** Byte i of the packet that starts here: in the pieces kept aside first, then in data */
  private byteAt(i: number, data: Buffer, at: number): number {
    let n = i;
    for (const p of this.pieces) {
      if (n < p.length) return p[n];
      n -= p.length;
    }
    return data[at + n];
  }

  /** Bytes received after the last whole packet */
  rest(): Buffer {
    const r = this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    this.pieces = [];
    this.size = 0;
    return r;
  }
}

/** Reads a payload field by field. */
export class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get left(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('packet too short');
    return this.buf[this.pos++];
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('packet too short');
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Up to the next NUL (or the end of the packet) */
  nulBytes(): Buffer {
    const end = this.buf.indexOf(0, this.pos);
    const stop = end < 0 ? this.buf.length : end;
    const v = this.buf.subarray(this.pos, stop);
    this.pos = end < 0 ? stop : stop + 1;
    return v;
  }

  nulString(): string {
    return this.nulBytes().toString('utf8');
  }

  lenenc(): number {
    const first = this.u8();
    if (first < 0xfb) return first;
    if (first === 0xfc) return this.u16();
    if (first === 0xfd) {
      const v = this.buf.readUIntLE(this.pos, 3);
      this.pos += 3;
      return v;
    }
    if (first === 0xfe) {
      const v = Number(this.buf.readBigUInt64LE(this.pos));
      this.pos += 8;
      return v;
    }
    throw new Error('bad length-encoded integer');
  }

  lenencBytes(): Buffer {
    return this.bytes(this.lenenc());
  }

  restBytes(): Buffer {
    return this.bytes(this.left);
  }
}

export function lenencInt(n: number): Buffer {
  if (n < 0xfb) return Buffer.from([n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 0xfc;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n < 0x1000000) {
    const b = Buffer.alloc(4);
    b[0] = 0xfd;
    b.writeUIntLE(n, 1, 3);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xfe;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

export function lenencBytes(v: Buffer | string): Buffer {
  const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  return Buffer.concat([lenencInt(b.length), b]);
}

const nul = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

// ── Server side (the gateway towards a client)

/** 20 random printable bytes, as servers send them */
export function newScramble(): Buffer {
  const b = crypto.randomBytes(20);
  for (let i = 0; i < b.length; i++) b[i] = 0x21 + (b[i] % 94);
  return b;
}

export interface Greeting {
  serverVersion: string;
  connectionId: number;
  scramble: Buffer;
  caps: number;
  charset: number;
  status: number;
  authPlugin: string;
}

export function buildGreeting(g: Greeting): Buffer {
  const caps = Buffer.alloc(4);
  caps.writeUInt32LE(g.caps >>> 0);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(g.connectionId >>> 0);
  const status = Buffer.alloc(2);
  status.writeUInt16LE(g.status);
  return Buffer.concat([
    Buffer.from([10]),
    nul(g.serverVersion),
    head,
    g.scramble.subarray(0, 8),
    Buffer.from([0]),
    caps.subarray(0, 2),
    Buffer.from([g.charset]),
    status,
    caps.subarray(2, 4),
    Buffer.from([g.scramble.length + 1]),
    Buffer.alloc(10),
    g.scramble.subarray(8),
    Buffer.from([0]),
    nul(g.authPlugin),
  ]);
}

export interface HandshakeResponse {
  caps: number;
  maxPacket: number;
  charset: number;
  /** Only SSL was asked for: the rest follows once TLS is up */
  sslRequest: boolean;
  user: string;
  authData: Buffer;
  database: string | null;
  authPlugin: string | null;
  attrs: Record<string, string>;
}

export function parseHandshakeResponse(payload: Buffer): HandshakeResponse {
  const r = new Reader(payload);
  const caps = r.u32();
  if (!(caps & CLIENT.PROTOCOL_41)) throw new Error('the client uses a protocol older than MySQL 4.1');
  const maxPacket = r.u32();
  const charset = r.u8();
  r.bytes(23);
  const base = { caps, maxPacket, charset, user: '', authData: Buffer.alloc(0), database: null, authPlugin: null, attrs: {} };
  if (r.left === 0) return { ...base, sslRequest: true };
  const user = r.nulString();
  let authData: Buffer;
  if (caps & CLIENT.PLUGIN_AUTH_LENENC) authData = r.lenencBytes();
  else if (caps & CLIENT.SECURE_CONNECTION) authData = r.bytes(r.u8());
  else authData = r.nulBytes();
  const database = caps & CLIENT.CONNECT_WITH_DB && r.left > 0 ? r.nulString() || null : null;
  const authPlugin = caps & CLIENT.PLUGIN_AUTH && r.left > 0 ? r.nulString() || null : null;
  const attrs: Record<string, string> = {};
  if (caps & CLIENT.CONNECT_ATTRS && r.left > 0) {
    const end = r.lenenc() + r.pos;
    while (r.pos < end && r.left > 0) {
      const k = r.lenencBytes().toString('utf8');
      attrs[k] = r.lenencBytes().toString('utf8');
    }
  }
  return { ...base, sslRequest: false, user, authData, database, authPlugin, attrs };
}

export function buildOk(status = 0x0002): Buffer {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(status);
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), s, Buffer.from([0x00, 0x00])]);
}

export function buildErr(code: number, sqlState: string, message: string): Buffer {
  const c = Buffer.alloc(2);
  c.writeUInt16LE(code);
  return Buffer.concat([Buffer.from([0xff]), c, Buffer.from(`#${sqlState}`, 'ascii'), Buffer.from(message, 'utf8')]);
}

export function buildAuthSwitch(plugin: string, scramble: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xfe]), nul(plugin), scramble, Buffer.from([0])]);
}

/** A parsed ERR packet */
export function parseErr(payload: Buffer): { code: number; sqlState: string; message: string } {
  const code = payload.readUInt16LE(1);
  const hasState = payload[3] === 0x23; // '#'
  return {
    code,
    sqlState: hasState ? payload.subarray(4, 9).toString('ascii') : 'HY000',
    message: payload.subarray(hasState ? 9 : 3).toString('utf8'),
  };
}

// ── Passwords

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest();
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest();

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
  return out;
}

/** What the gateway keeps for a password: the double hash each plugin checks against. */
export function passwordHashes(password: string): { native: string; sha2: string } {
  const p = Buffer.from(password, 'utf8');
  return { native: sha1(sha1(p)).toString('hex'), sha2: sha256(sha256(p)).toString('hex') };
}

/** The client's mysql_native_password answer, as a client computes it */
export function nativeToken(password: string, scramble: Buffer): Buffer {
  const s1 = sha1(Buffer.from(password, 'utf8'));
  return xor(s1, sha1(Buffer.concat([scramble.subarray(0, 20), sha1(s1)])));
}

/** The client's caching_sha2_password answer, as a client computes it */
export function sha2Token(password: string, scramble: Buffer): Buffer {
  const s1 = sha256(Buffer.from(password, 'utf8'));
  return xor(s1, sha256(Buffer.concat([sha256(s1), scramble.subarray(0, 20)])));
}

/** Checks a mysql_native_password answer against SHA1(SHA1(password)). */
export function checkNative(token: Buffer, scramble: Buffer, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  if (token.length !== 20 || stored.length !== 20) return false;
  const candidate = xor(token, sha1(Buffer.concat([scramble.subarray(0, 20), stored])));
  return crypto.timingSafeEqual(sha1(candidate), stored);
}

/** Checks a caching_sha2_password answer against SHA256(SHA256(password)). */
export function checkSha2(token: Buffer, scramble: Buffer, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  if (token.length !== 32 || stored.length !== 32) return false;
  const candidate = xor(token, sha256(Buffer.concat([stored, scramble.subarray(0, 20)])));
  return crypto.timingSafeEqual(sha256(candidate), stored);
}

/** caching_sha2_password over an unencrypted link: the password, XORed with the scramble, RSA-encrypted. */
export function rsaPassword(password: string, scramble: Buffer, publicKeyPem: Buffer): Buffer {
  const plain = xor(Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]), scramble.subarray(0, 20));
  return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, plain);
}

/** A strong random password of letters and digits (safe in URLs and config files) */
export function randomPassword(length = 32): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Rejection sampling keeps every character equally likely
    if (bytes[i] < 256 - (256 % chars.length)) out += chars[bytes[i] % chars.length];
  }
  return out.length === length ? out : randomPassword(length);
}

// ── The log

/** The most that is kept of one logged statement */
export const MAX_LOGGED_SQL = 64 * 1024;
/** Leading comments longer than this are left out of the log */
const MAX_LEADING_COMMENTS = 2000;

/** Where the statement itself starts: past whitespace and comments (`/*!` and `/*+` belong to the statement) */
function statementStart(sql: string): number {
  const n = sql.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/.test(sql[i])) i++;
    let end = -1;
    if (sql.startsWith('--', i) || sql[i] === '#') end = sql.indexOf('\n', i);
    else if (sql.startsWith('/*', i) && sql[i + 2] !== '!' && sql[i + 2] !== '+') end = sql.indexOf('*/', i + 2) < 0 ? -1 : sql.indexOf('*/', i + 2) + 1;
    else return i;
    if (end < 0) return n;
    i = end + 1;
  }
}

/**
 * A statement as it goes into the log. Long leading comments are replaced by a note of their length:
 * cut off at a fixed length, a statement behind a long comment left nothing of itself in the log.
 */
export function logText(sql: string): string {
  const start = statementStart(sql);
  // Only comments are left out, and only when there is a lot of them (whitespace in front is not hiding anything)
  const text = start > MAX_LEADING_COMMENTS && start > sql.length - sql.trimStart().length
    ? `/* ${start} characters of comments left out */ ${sql.slice(start)}`
    : sql;
  return text.length > MAX_LOGGED_SQL ? `${text.slice(0, MAX_LOGGED_SQL)}… (${text.length} characters)` : text;
}

/** The most that is kept of a prepared statement's parameters */
const MAX_LOGGED_PARAMETERS = 1024;

/** A prepared statement's execution for the log: which statement, and the parameters sent with it, as bytes */
export function executeText(payload: Buffer): string {
  if (payload.length < 10) return 'EXECUTE (a packet too short to read)';
  const values = payload.subarray(10);
  const shown = values.subarray(0, MAX_LOGGED_PARAMETERS).toString('hex');
  return `EXECUTE #${payload.readUInt32LE(1)}, ${values.length} bytes of parameters${values.length > MAX_LOGGED_PARAMETERS ? ` (first ${MAX_LOGGED_PARAMETERS})` : ''}: ${shown}`;
}
