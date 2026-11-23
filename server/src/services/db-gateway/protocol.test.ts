import { describe, it, expect } from 'vitest';
import {
  CLIENT, Packet, PacketSplitter, buildGreeting, checkNative, checkSha2, encodePacket, nativeToken, newScramble,
  parseHandshakeResponse, passwordHashes, randomPassword, sha2Token, lenencBytes,
} from './protocol';
import { normalizePrivileges, onlyReads, PRESETS } from './provision';
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
  });
});
