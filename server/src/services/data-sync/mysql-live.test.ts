import { describe, it, expect } from 'vitest';
import { ambiguousEnumValues, truncatedTable, classifySourceError } from './mysql-live';

describe('live sync helpers', () => {
  it('finds ENUM/SET values the binary log reader cannot tell apart', () => {
    expect(ambiguousEnumValues("enum('a','b','x')")).toEqual([]);
    expect(ambiguousEnumValues("set('p','q')")).toEqual([]);
    expect(ambiguousEnumValues("enum('a','b,c')")).toEqual(['b,c']);
    expect(ambiguousEnumValues("enum('it''s','b')")).toEqual(["it''s"]);
    expect(ambiguousEnumValues('varchar(20)')).toEqual([]);
  });

  it('reads the table of a TRUNCATE, only in the followed database', () => {
    expect(truncatedTable('TRUNCATE TABLE orders', 'shop', 'shop')).toBe('orders');
    expect(truncatedTable('TRUNCATE `my table`', 'shop', 'shop')).toBe('my table');
    expect(truncatedTable('truncate table `shop`.`Orders`;', 'other', 'shop')).toBe('Orders');
    expect(truncatedTable('TRUNCATE TABLE other.orders', 'shop', 'shop')).toBeNull();
    expect(truncatedTable('TRUNCATE TABLE orders', 'other', 'shop')).toBeNull();
    expect(truncatedTable('DELETE FROM orders', 'shop', 'shop')).toBeNull();
  });

  it('tells which source errors need the user, a catch-up, or just a retry', () => {
    expect(classifySourceError(Object.assign(new Error('Access denied; you need (at least one of) the REPLICATION SLAVE privilege(s)'), { errno: 1227 })).kind).toBe('CONFIG');
    expect(classifySourceError(Object.assign(new Error('Could not find first log file name in binary log index file'), { errno: 1236 })).kind).toBe('RESYNC');
    expect(classifySourceError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })).kind).toBe('TRANSIENT');
  });
});
