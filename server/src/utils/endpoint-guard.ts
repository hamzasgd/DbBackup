import dns from 'dns';
import net from 'net';

/**
 * Guard for user-supplied service endpoints (e.g. S3-compatible storage).
 *
 * Self-hosted setups legitimately point at private hosts (a MinIO container, a
 * LAN NAS), so private ranges are allowed. What is refused is what has no
 * legitimate use for a storage endpoint and is the classic SSRF prize:
 * non-HTTP(S) schemes, URLs carrying credentials, and link-local / cloud
 * metadata addresses (169.254.0.0/16, fe80::/10, fd00:ec2::254).
 */

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export class UnsafeEndpointError extends Error {}

function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6: written dotted (::ffff:1.2.3.4) or, after URL normalisation, as hex (::ffff:0102:0304)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 169 && b === 254; // link-local incl. 169.254.169.254 metadata
  }
  if (net.isIPv6(ip)) {
    return ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')
      || ip === 'fd00:ec2::254';
  }
  return false;
}

/** Synchronous checks: scheme, embedded credentials, literal blocked hosts. Returns the parsed URL. */
export function parseSafeEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnsafeEndpointError('Endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeEndpointError('Endpoint must use http:// or https://');
  }
  if (url.username || url.password) {
    throw new UnsafeEndpointError('Endpoint must not contain credentials');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || isBlockedAddress(host)) {
    throw new UnsafeEndpointError('Endpoint points to a blocked address');
  }
  return url;
}

/** parseSafeEndpoint plus a DNS check, so a hostname can't resolve to a blocked address. */
export async function assertSafeEndpoint(endpoint: string): Promise<URL> {
  const url = parseSafeEndpoint(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    let addrs: dns.LookupAddress[];
    try {
      addrs = await dns.promises.lookup(host, { all: true });
    } catch {
      throw new UnsafeEndpointError('Endpoint host could not be resolved');
    }
    if (addrs.some((a) => isBlockedAddress(a.address))) {
      throw new UnsafeEndpointError('Endpoint resolves to a blocked address');
    }
  }
  return url;
}
