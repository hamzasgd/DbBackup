import { describe, it, expect } from 'vitest';
import net from 'net';
import { PacketChannel } from './channel';
import { CLIENT, encodePacket } from './protocol';

/** A connection over loopback: what `client` writes reaches `server` */
async function pair(server: (sock: net.Socket) => Promise<void>) {
  const listener = net.createServer();
  const done = new Promise<void>((resolve, reject) => {
    listener.once('connection', (sock) => server(sock).then(resolve, reject));
  });
  const port = await new Promise<number>((resolve) => {
    listener.listen(0, '127.0.0.1', () => resolve((listener.address() as net.AddressInfo).port));
  });
  const client = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));
  client.on('error', () => {});
  return {
    client,
    done,
    close: async () => {
      client.destroy();
      await done;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('the login channel', () => {
  it('hands back the start of TLS whole when it arrives in the same read as the request for it', async () => {
    // 0x16 0x03 0x01 is the start of every TLS record. Read as a packet header, that says 66,326 bytes
    const startOfTls = Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc]);
    const later = Buffer.from([0x17, 0x03, 0x03, 0x00, 0x05, 0x00]);
    let got: Buffer = Buffer.alloc(0);
    let failure: unknown = null;
    const p = await pair(async (sock) => {
      const ch = new PacketChannel(sock);
      try {
        expect((await ch.next()).seq).toBe(1);
        // TLS would read from here on
        const raw = ch.pauseForTls();
        const chunks: Buffer[] = [];
        raw.on('data', (d: Buffer) => chunks.push(d));
        raw.on('error', () => {});
        const end = Date.now() + 1500;
        while (Buffer.concat(chunks).length < startOfTls.length + later.length && Date.now() < end) await pause(10);
        got = Buffer.concat(chunks);
      } catch (e) {
        failure = e;
      }
    });
    const request = Buffer.alloc(32);
    request.writeUInt32LE((CLIENT.SSL | CLIENT.PROTOCOL_41) >>> 0, 0);
    p.client.write(Buffer.concat([encodePacket(1, request), startOfTls]));
    // Only once the gateway has dealt with that read
    await pause(150);
    p.client.write(later);
    await p.done;
    expect(failure).toBeNull();
    expect(got.equals(Buffer.concat([startOfTls, later]))).toBe(true);
    await p.close();
  });

  it('gives up on a login packet that grows past its limit', async () => {
    const outcome: { failure: Error | null } = { failure: null };
    const p = await pair(async (sock) => {
      sock.on('error', () => {});
      try {
        await new PacketChannel(sock).next();
      } catch (e) {
        outcome.failure = e as Error;
      }
    });
    // A header that says 100 KiB, then a little: waited for
    p.client.write(Buffer.concat([Buffer.from([0x00, 0x90, 0x01]), Buffer.alloc(1000)]));
    await pause(100);
    expect(outcome.failure).toBeNull();
    p.client.write(Buffer.alloc(70_000));
    await p.done;
    expect(outcome.failure?.message).toMatch(/more than 65536 bytes arrived for one packet/);
    await p.close();
  });
});
