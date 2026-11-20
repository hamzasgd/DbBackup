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
