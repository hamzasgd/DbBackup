import { describe, it, expect } from 'vitest';
import { parseSafeEndpoint, UnsafeEndpointError } from './endpoint-guard';

describe('parseSafeEndpoint', () => {
  it.each([
    'https://s3.eu-west-1.amazonaws.com',
    'http://minio:9000',
    'http://10.0.0.5:9000',
    'http://localhost:9000',
    'https://example.com/path',
  ])('allows %s', (url) => {
    expect(parseSafeEndpoint(url).href).toBeTruthy();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'http://user:pass@example.com/',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(() => parseSafeEndpoint(url)).toThrow(UnsafeEndpointError);
  });
});
