import { describe, it, expect } from 'vitest';
import { mysqlCompressArgsFor, mysqlClientHasCompressionAlgorithms } from './cli-safety';

const ORACLE_8 = 'mysqldump  Ver 8.0.46-0ubuntu0.24.04.5 for Linux on x86_64 ((Ubuntu))';
const ZSTD = ['--compression-algorithms=zstd,uncompressed'];
const ZLIB = ['--compression-algorithms=zlib,uncompressed'];

describe('mysqlClientHasCompressionAlgorithms', () => {
  it('is true only for Oracle MySQL clients 8.0.18 and later', () => {
    expect(mysqlClientHasCompressionAlgorithms(ORACLE_8)).toBe(true);
    expect(mysqlClientHasCompressionAlgorithms('mysqldump  Ver 8.0.18 for Linux on x86_64')).toBe(true);
    expect(mysqlClientHasCompressionAlgorithms('mysql  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)')).toBe(true);
    expect(mysqlClientHasCompressionAlgorithms('mysqldump  Ver 9.1.0 for macos14 on arm64 (Homebrew)')).toBe(true);
    expect(mysqlClientHasCompressionAlgorithms('mysqldump  Ver 8.0.17 for Linux on x86_64')).toBe(false);
    // 5.7: "Ver 10.13" is the tool version, Distrib is the release
    expect(mysqlClientHasCompressionAlgorithms('mysqldump  Ver 10.13 Distrib 5.7.44, for Linux (x86_64)')).toBe(false);
    expect(mysqlClientHasCompressionAlgorithms('mysqldump  Ver 10.19 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64)')).toBe(false);
    expect(mysqlClientHasCompressionAlgorithms('')).toBe(false);
  });
});

describe('mysqlCompressArgsFor', () => {
  it('uses --compress for MariaDB and older Oracle clients', () => {
    expect(mysqlCompressArgsFor('mariadb-dump  Ver 10.19 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64)', 'zlib,zstd,uncompressed')).toEqual(['--compress']);
    expect(mysqlCompressArgsFor('mysqldump  Ver 10.13 Distrib 5.7.44, for Linux (x86_64)')).toEqual(['--compress']);
  });

  it('asks for zstd alone when the server allows it (MySQL would otherwise pick zlib)', () => {
    expect(mysqlCompressArgsFor(ORACLE_8, 'zlib,zstd,uncompressed')).toEqual(ZSTD);
    expect(mysqlCompressArgsFor(ORACLE_8, 'zstd')).toEqual(ZSTD);
  });

  it('falls back to zlib when the server has no zstd or did not say', () => {
    expect(mysqlCompressArgsFor(ORACLE_8, 'zlib,uncompressed')).toEqual(ZLIB);
    expect(mysqlCompressArgsFor(ORACLE_8, null)).toEqual(ZLIB); // MariaDB / MySQL < 8.0.18 server
  });
});
