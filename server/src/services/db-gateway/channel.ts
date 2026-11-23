import { Duplex } from 'stream';

/**
 * The socket, with bytes already read from it put back in front. A client
 * may send the start of the TLS handshake in the same read as its SSL request.
 */
function withLeftover(socket: Duplex, left: Buffer): Duplex {
  const joined = new Duplex({
    read() { socket.resume(); },
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
    destroy(err, cb) { socket.destroy(err ?? undefined); cb(err); },
  });
  joined.push(left);
  socket.on('data', (d: Buffer) => { if (!joined.push(d)) socket.pause(); });
  socket.on('end', () => joined.push(null));
  socket.on('error', (e) => joined.destroy(e));
  socket.on('close', () => joined.destroy());
  return joined;
}
import { encodePacket, Packet, PacketSplitter } from './protocol';

/** Login packets are a few hundred bytes; a long one before login only uses the gateway's memory */
export const MAX_LOGIN_PACKET = 64 * 1024;
/** What a client may send before it is asked for it: after its login, the first commands sent early */
const MAX_QUEUED = 256 * 1024;

/**
 * Packet-by-packet reading of a socket during login. Afterwards detach() hands
 * back every byte read but not yet consumed, so the socket can be piped raw.
 */
export class PacketChannel {
  private splitter = new PacketSplitter(MAX_LOGIN_PACKET);
  private queue: Packet[] = [];
  private queued = 0;
  private waiting: { resolve: (p: Packet) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private readonly onData = (d: Buffer) => {
    try {
      for (const p of this.splitter.push(d)) {
        this.queued += p.payload.length + 4;
        // Nobody reads this yet: a client sending more is not waiting for an answer
        if (this.queued > MAX_QUEUED) throw new Error('too much data before the login is done');
        this.queue.push(p);
      }
    } catch (e) {
      this.fail(e as Error);
    }
    this.flush();
  };
  private readonly onEnd = () => this.fail(new Error('connection closed'));
  private readonly onError = (e: Error) => this.fail(e);

  constructor(private stream: Duplex) {
    this.attach(stream);
  }

  private attach(stream: Duplex): void {
    this.stream = stream;
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('close', this.onEnd);
    stream.on('error', this.onError);
  }

  private flush(): void {
    if (!this.waiting) return;
    if (this.queue.length) {
      const w = this.waiting;
      this.waiting = null;
      clearTimeout(w.timer);
      const p = this.queue.shift()!;
      this.queued -= p.payload.length + 4;
      w.resolve(p);
    } else if (this.failure) {
      const w = this.waiting;
      this.waiting = null;
      clearTimeout(w.timer);
      w.reject(this.failure);
    }
  }

  private fail(e: Error): void {
    if (!this.failure) this.failure = e;
    this.flush();
  }

  /** The next packet, or an error when the peer goes away or takes too long */
  next(timeoutMs = 15_000): Promise<Packet> {
    if (this.waiting) return Promise.reject(new Error('already reading'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('timed out waiting for the other side'));
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.flush();
    });
  }

  write(seq: number, payload: Buffer): void {
    this.stream.write(encodePacket(seq, payload));
  }

  /** Stop reading; returns the bytes read but not yet consumed. */
  detach(): Buffer {
    this.stream.off('data', this.onData);
    this.stream.off('end', this.onEnd);
    this.stream.off('close', this.onEnd);
    this.stream.off('error', this.onError);
    const pending = this.queue.map((p) => encodePacket(p.seq, p.payload));
    this.queue = [];
    this.queued = 0;
    return Buffer.concat([...pending, this.splitter.rest()]);
  }

  /**
   * Stop reading the plain socket before TLS is set up on it (TLS must get
   * every byte from then on). Call use() with the TLS socket afterwards.
   */
  pauseForTls(): Duplex {
    const left = this.detach();
    return left.length ? withLeftover(this.stream, left) : this.stream;
  }

  /** Read from the TLS socket on the same connection from now on. */
  use(stream: Duplex): void {
    this.failure = null;
    this.attach(stream);
  }
}
