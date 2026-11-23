import { describe, it, expect } from 'vitest';
import {
  CLIENT, COM, LOGGED_COMMANDS, MAX_LOGGED_SQL, Packet, PacketSplitter, buildGreeting, checkNative, checkSha2, commandText,
  encodePacket, executeText, logText, nativeToken, newScramble, parseHandshakeResponse, passwordHashes, randomPassword,
  readStatement, shellQuote, sha2Token, statementDecoder, lenencBytes,
} from './protocol';
import { grantStatements, normalizePrivileges, onlyReads, PRESETS, WRITE_PRIVILEGES } from './provision';
import { gatewayConfig } from './gateway.service';

describe('gateway protocol', () => {
  it('accepts the right password with either login method, and nothing else', () => {
    const pw = randomPassword(24);
    const h = passwordHashes(pw);
    const scramble = newScramble();
    expect(checkSha2(sha2Token(pw, scramble), scramble, h.sha2)).toBe(true);
    expect(checkNative(nativeToken(pw, scramble), scramble, h.native)).toBe(true);
    // Wrong password, another login's scramble, or a token of the wrong length
    expect(checkSha2(sha2Token(`${pw}x`, scramble), scramble, h.sha2)).toBe(false);
    expect(checkSha2(sha2Token(pw, newScramble()), scramble, h.sha2)).toBe(false);
    expect(checkNative(nativeToken(pw, scramble), scramble, h.sha2)).toBe(false);
    expect(checkSha2(Buffer.alloc(0), scramble, h.sha2)).toBe(false);
  });

  it('makes passwords of letters and digits only', () => {
    for (let i = 0; i < 50; i++) expect(randomPassword(32)).toMatch(/^[A-Za-z2-9]{32}$/);
  });

  it('splits a stream into packets, across reads', () => {
    const a = encodePacket(0, Buffer.from('hello'));
    const b = encodePacket(1, Buffer.alloc(300, 7));
    const all = Buffer.concat([a, b]);
    const s = new PacketSplitter();
    expect(s.push(all.subarray(0, 3))).toEqual([]);
    const got = [...s.push(all.subarray(3, 20)), ...s.push(all.subarray(20))];
    expect(got.map((p) => [p.seq, p.payload.length])).toEqual([[0, 5], [1, 300]]);
    expect(s.rest().length).toBe(0);
  });

  it('joins a long packet that comes in many pieces, and refuses one that is too long', () => {
    const long = Buffer.alloc(70_000, 0x5a);
    // The first packet is 98 bytes on the wire, so the next one's header straddles the 100-byte pieces
    const all = Buffer.concat([encodePacket(0, Buffer.alloc(94)), encodePacket(5, long), encodePacket(6, Buffer.from('tail'))]);
    const s = new PacketSplitter();
    const got: Packet[] = [];
    for (let i = 0; i < all.length; i += 100) got.push(...s.push(all.subarray(i, i + 100)));
    expect(got.map((p) => [p.seq, p.payload.length])).toEqual([[0, 94], [5, 70_000], [6, 4]]);
    expect(got[1].payload.equals(long)).toBe(true);
    expect(got[2].payload.toString()).toBe('tail');
    expect(s.rest().length).toBe(0);
    // With a limit, as before a login
    const small = new PacketSplitter(1000);
    expect(() => small.push(encodePacket(0, Buffer.alloc(1001)))).toThrow(/longer than the 1000 allowed/);
    expect(small.push(encodePacket(0, Buffer.alloc(1000)))).toHaveLength(1);
  });

  it('reads a client login packet', () => {
    const caps = CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC |
      CLIENT.CONNECT_WITH_DB | CLIENT.CONNECT_ATTRS;
    const head = Buffer.alloc(32);
    head.writeUInt32LE(caps, 0);
    head.writeUInt32LE(1 << 24, 4);
    head[8] = 45;
    const token = Buffer.alloc(32, 1);
    const attrs = Buffer.concat([lenencBytes('program_name'), lenencBytes('DBeaver')]);
    const payload = Buffer.concat([head, Buffer.from('ali\0'), lenencBytes(token), Buffer.from('shop\0'),
      Buffer.from('caching_sha2_password\0'), lenencBytes(attrs)]);
    const r = parseHandshakeResponse(payload);
    expect(r).toMatchObject({ sslRequest: false, user: 'ali', database: 'shop', authPlugin: 'caching_sha2_password', charset: 45 });
    expect(r.authData.equals(token)).toBe(true);
    expect(r.attrs).toEqual({ program_name: 'DBeaver' });
    // Only the fixed part: a request to switch to TLS
    expect(parseHandshakeResponse(head).sslRequest).toBe(true);
  });

  it('writes a greeting with the scramble split in two', () => {
    const scramble = newScramble();
    const g = buildGreeting({ serverVersion: '8.0.40', connectionId: 7, scramble, caps: 0xffff, charset: 45, status: 2, authPlugin: 'caching_sha2_password' });
    expect(g[0]).toBe(10);
    const at = g.indexOf(0, 1) + 1;
    expect(g.readUInt32LE(at)).toBe(7);
    expect(g.subarray(at + 4, at + 12).equals(scramble.subarray(0, 8))).toBe(true);
    expect(g.includes(scramble.subarray(8))).toBe(true);
    expect(g.subarray(-22).toString()).toBe('caching_sha2_password\0');
  });
});

describe('access rights', () => {
  it('keeps to the rights MySQL allows for the scope', () => {
    expect(normalizePrivileges(['select', 'Show View'], false)).toEqual(['SELECT', 'SHOW VIEW']);
    expect(() => normalizePrivileges(['EXECUTE'], true)).toThrow(/whole database/);
    expect(() => normalizePrivileges(['SUPER'], false)).toThrow(/Unknown right/);
    expect(() => normalizePrivileges(['GRANT OPTION'], false)).toThrow(/Unknown right/);
    expect(() => normalizePrivileges([], false)).toThrow(/at least one/);
  });

  it('tells read-only rights apart', () => {
    expect(onlyReads(PRESETS.read)).toBe(true);
    expect(onlyReads(PRESETS.write)).toBe(false);
  });
});

describe('gateway settings', () => {
  it('is off without a port, and requires TLS unless told otherwise', () => {
    expect(gatewayConfig({}).port).toBeNull();
    const c = gatewayConfig({ DB_GATEWAY_PORT: '3307', FRONTEND_URL: 'https://dbbackup.example.com' });
    expect(c).toMatchObject({ port: 3307, bind: '0.0.0.0', publicHost: 'dbbackup.example.com', requireTls: true, logDays: 30, maxConnections: 500 });
    expect(gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_REQUIRE_TLS: 'false' }).requireTls).toBe(false);
    expect(gatewayConfig({ DB_GATEWAY_PORT: '99999' }).port).toBeNull();
    // The connection limit: set, or the default; never more than 5000
    expect(gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_MAX_CONNECTIONS: '1200.7' }).maxConnections).toBe(1200);
    expect(gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_MAX_CONNECTIONS: '0' }).maxConnections).toBe(500);
    expect(gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_MAX_CONNECTIONS: '99999999' }).maxConnections).toBe(5000);
    // The password does not go to a database that is not vouched for unless the network is called private; the
    // version is the gateway's own; the log has a size
    const off = gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_TRUST_PRIVATE_NETWORK: 'yes' });
    expect(off.trustNetwork).toBe(false);
    expect(off.advertisedVersion).toBe('8.0.40');
    expect(off.logMaxBytes).toBe(1000 * 1024 * 1024);
    expect(gatewayConfig({ DB_GATEWAY_PORT: '3307', DB_GATEWAY_TRUST_PRIVATE_NETWORK: 'true', DB_GATEWAY_ADVERTISED_VERSION: ' 5.5.5-10.11-MariaDB ' }))
      .toMatchObject({ trustNetwork: true, advertisedVersion: '5.5.5-10.11-MariaDB' });
    expect(gatewayConfig({ DB_GATEWAY_LOG_MAX_MB: '0' }).logMaxBytes).toBe(0);
    expect(gatewayConfig({ DB_GATEWAY_LOG_MAX_MB: '250' }).logMaxBytes).toBe(250 * 1024 * 1024);
    expect(gatewayConfig({ DB_GATEWAY_LOG_MAX_MB: '-5' }).logMaxBytes).toBe(1000 * 1024 * 1024);
  });
});

describe('the log and the grants', () => {
  it('names the commands that change a session', () => {
    expect(commandText(COM.PROCESS_KILL, Buffer.from([COM.PROCESS_KILL, 7, 0, 0, 0]))).toBe('KILL CONNECTION 7');
    expect(commandText(COM.SET_OPTION, Buffer.from([COM.SET_OPTION, 0, 0]))).toBe('SET OPTION multi statements off');
    expect(commandText(COM.RESET_CONNECTION, Buffer.from([COM.RESET_CONNECTION]))).toBe('RESET CONNECTION');
    expect(commandText(COM.STMT_SEND_LONG_DATA, Buffer.concat([Buffer.from([COM.STMT_SEND_LONG_DATA, 1, 0, 0, 0, 0, 0]), Buffer.from('abcd')])))
      .toBe('SEND LONG DATA (4 bytes)');
    expect(commandText(COM.STMT_RESET, Buffer.from([COM.STMT_RESET, 1, 0, 0, 0]))).toBe('RESET STATEMENT');
    expect(LOGGED_COMMANDS.has(COM.PING)).toBe(false);
  });

  it('reads a statement in the character set the session uses, and follows a change of it', () => {
    // 45 is utf8mb4, 8 latin1
    const utf8 = statementDecoder(45);
    const latin1 = statementDecoder(8);
    expect(utf8.encoding).toBe('utf-8');
    expect(latin1.encoding).toBe('windows-1252');
    // caf<e9>: "café" in latin1, a broken character in UTF-8
    const cafe = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(readStatement(cafe, utf8).sql).not.toBe('café');
    expect(readStatement(cafe, latin1)).toEqual({ sql: 'café' });

    // The statement that changes the character set says so for what follows
    const toLatin1 = readStatement(Buffer.from('SET NAMES latin1'), utf8);
    expect(toLatin1.sql).toBe('SET NAMES latin1');
    expect(toLatin1.next?.encoding).toBe('windows-1252');
    for (const sql of ['set session character_set_client = gbk', 'SET CHARACTER SET big5', "SET NAMES 'sjis'", 'SET @@session.charset = euckr']) {
      expect(readStatement(Buffer.from(sql), utf8).next?.encoding, sql).toBeTruthy();
    }
    // Already in it, or something else (DEFAULT, a name not known here): nothing to change
    expect(readStatement(Buffer.from('SET NAMES latin1'), latin1).next).toBeUndefined();
    expect(readStatement(Buffer.from('SET NAMES DEFAULT'), utf8).next).toBeUndefined();
    expect(readStatement(Buffer.from('SET NAMES klingon'), utf8).next).toBeUndefined();
    expect(readStatement(Buffer.from("SELECT 'SET NAMES gbk' AS s"), utf8).next).toBeUndefined();
  });

  it('quotes a value for a shell as it is', () => {
    expect(shellQuote('shop')).toBe("'shop'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('x; rm -rf ~')).toBe("'x; rm -rf ~'");
    expect(shellQuote('$(whoami)`id`')).toBe("'$(whoami)`id`'");
  });

  it('keeps a statement visible behind long comments, and keeps long statements short', () => {
    expect(logText('-- for ticket 1234\nDELETE FROM t')).toBe('-- for ticket 1234\nDELETE FROM t');
    expect(logText(`-- ${'x'.repeat(5000)}\nDELETE FROM t`)).toMatch(/^\/\* \d+ characters of comments left out \*\/ DELETE FROM t$/);
    expect(logText(`/*${'y'.repeat(3000)}*/ UPDATE t SET a = 1`)).toMatch(/^\/\* \d+ characters of comments left out \*\/ UPDATE t SET a = 1$/);
    // `/*!` and `/*+` are part of the statement, and whitespace is not a comment
    expect(logText(`/*!${'y'.repeat(3000)}*/ SELECT 1`)).toBe(`/*!${'y'.repeat(3000)}*/ SELECT 1`);
    expect(logText(` ${' '.repeat(3000)}SELECT 1`)).toMatch(/^ +SELECT 1$/);
    // Only comments are left out: text that is the statement itself is cut off, and it says so
    const long = logText(`SELECT '${'a'.repeat(70_000)}'`);
    expect(long.length).toBeLessThan(MAX_LOGGED_SQL + 30);
    expect(long).toMatch(/… \(\d+ characters\)$/);
  });

  it('names the statement and shows the parameters of a prepared statement execution', () => {
    expect(executeText(Buffer.alloc(9))).toMatch(/too short/);
    expect(executeText(Buffer.concat([Buffer.from([COM.STMT_EXECUTE, 5, 0, 0, 0, 0, 1, 0, 0, 0]), Buffer.from('abc')]))).toBe('EXECUTE #5, 3 bytes of parameters: 616263');
  });

  it('escapes _ and % in the database of a whole-database grant, nowhere else', () => {
    const g = (database: string, tables: string[]) => grantStatements({ database, tables, privileges: ['SELECT'], maxConnections: 1 });
    // In `db.*` the database would otherwise match `shop-db` and `shopXdb` too
    expect(g('shop_db', [])).toEqual(['GRANT SELECT ON `shop\\_db`.* TO ?@?']);
    expect(g('a%b`c', [])).toEqual(['GRANT SELECT ON `a\\%b``c`.* TO ?@?']);
    // As the database of a table-level grant the name is literal, and so is the table's
    expect(g('shop_db', ['a_b', 'c%'])).toEqual(['GRANT SELECT ON `shop_db`.`a_b` TO ?@?', 'GRANT SELECT ON `shop_db`.`c%` TO ?@?']);
  });

  it('tells the rights that change something apart', () => {
    expect(WRITE_PRIVILEGES).not.toContain('SELECT');
    expect(WRITE_PRIVILEGES).not.toContain('SHOW VIEW');
    expect(WRITE_PRIVILEGES).toEqual(expect.arrayContaining(['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRIGGER', 'EVENT']));
    expect(onlyReads(WRITE_PRIVILEGES)).toBe(false);
  });
});
