import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { optionFileValue } from './mysql-remote';
import { shellQuote } from '../ssh.service';
import { resolveToolStrategy } from '../tool-strategy';
import { supportsSshServerStrategy } from './base.engine';

describe('remote tool helpers', () => {
  it('shell-quotes any value into one literal word', () => {
    for (const v of ['plain', "it's", 'a b', '$HOME', '`id`', '"x"', '\\', ';rm -rf /', '', "''"]) {
      // printf receives exactly the original value back
      const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(v)}`]).toString();
      expect(out).toBe(v);
    }
  });

  it('escapes option-file values (quotes, backslashes, newlines)', () => {
    expect(optionFileValue('simple')).toBe('"simple"');
    expect(optionFileValue('pa"ss\\w\'o#rd')).toBe('"pa\\"ss\\\\w\'o#rd"');
    expect(optionFileValue('a\nb\tc')).toBe('"a\\nb\\tc"');
  });
});

describe('resolveToolStrategy', () => {
  const ssh = { name: 'Casa AWS', type: 'MYSQL', sshEnabled: true };

  it('defaults to the tunnel', () => {
    expect(resolveToolStrategy(undefined, ssh)).toBe('TUNNEL');
    expect(resolveToolStrategy(null, ssh)).toBe('TUNNEL');
    expect(resolveToolStrategy('TUNNEL', { ...ssh, sshEnabled: false })).toBe('TUNNEL');
  });

  it('allows the SSH server for SSH MySQL/MariaDB connections only', () => {
    expect(resolveToolStrategy('SSH_SERVER', ssh)).toBe('SSH_SERVER');
    expect(resolveToolStrategy('SSH_SERVER', { ...ssh, type: 'MARIADB' })).toBe('SSH_SERVER');
    expect(() => resolveToolStrategy('SSH_SERVER', { ...ssh, sshEnabled: false })).toThrow(/doesn't use SSH/);
    expect(() => resolveToolStrategy('SSH_SERVER', { ...ssh, type: 'POSTGRESQL' })).toThrow(/isn't available for PostgreSQL/);
    expect(() => resolveToolStrategy('ELSEWHERE', ssh)).toThrow(/Unknown strategy/);
    expect(supportsSshServerStrategy('MONGODB')).toBe(false);
  });
});

describe('matchTargetTable', () => {
  it('prefers the exact name, else the one name that differs only in case', async () => {
    const { matchTargetTable } = await import('../data-sync/mysql-data-sync');
    expect(matchTargetTable('AppSettings', ['appsettings', 'members'])).toBe('appsettings');
    expect(matchTargetTable('AppSettings', ['AppSettings', 'appsettings'])).toBe('AppSettings');
    expect(matchTargetTable('Foo', ['foo', 'FOO'])).toBeNull(); // ambiguous
    expect(matchTargetTable('missing', ['members'])).toBeNull();
  });
});

describe('rangeWhere', () => {
  it('keeps a one-column key as a plain comparison', async () => {
    const { rangeWhere } = await import('../data-sync/mysql-data-sync');
    expect(rangeWhere(['id'], [10], [20])).toEqual({ sql: '`id` > ? AND `id` <= ?', params: [10, 20] });
    expect(rangeWhere(['id'], null, null)).toEqual({ sql: '1=1', params: [] });
  });

  it('spells out a multi-column key so MySQL can use a range scan', async () => {
    const { rangeWhere } = await import('../data-sync/mysql-data-sync');
    const w = rangeWhere(['a', 'b', 'c'], [1, 'x', 3], null);
    expect(w.sql).toBe('`a` >= ? AND (`a` > ? OR (`a` = ? AND (`b` > ? OR (`b` = ? AND `c` > ?))))');
    expect(w.params).toEqual([1, 1, 1, 'x', 'x', 3]);
    const h = rangeWhere(['a', 'b'], null, [5, 'y']);
    expect(h.sql).toBe('`a` <= ? AND (`a` < ? OR (`a` = ? AND `b` <= ?))');
    expect(h.params).toEqual([5, 5, 5, 'y']);
    expect(h.sql).not.toMatch(/\(`a`, `b`\)/);
  });
});
