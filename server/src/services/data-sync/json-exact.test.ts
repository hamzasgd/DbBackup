import { describe, it, expect } from 'vitest';
import { scanJson, sameJson, jsonCell } from './json-exact';

describe('exact JSON numbers', () => {
  it('finds fractional numbers with their MySQL paths', () => {
    const s = scanJson('{"a": 1, "b": {"c": 5.684341886080802e-14, "d": [0.5, 2, {"e": -1.25E+3}]}, "k\\"q": 0.1}');
    expect(s?.fractions).toEqual([
      { path: '$."b"."c"', text: '5.684341886080802e-14' },
      { path: '$."b"."d"[0]', text: '0.5' },
      { path: '$."b"."d"[2]."e"', text: '-1.25E+3' },
      { path: '$."k\\"q"', text: '0.1' },
    ]);
  });

  it('treats the same double printed two ways as the same', () => {
    expect(sameJson('{"n": 12345678901234567890, "x": 5.684341886080802e-14}', '{"n": 12345678901234567890, "x": 0.00000000000005684341886080802}')).toBe(true);
    expect(sameJson('{"x": 5.684341886080802e-14}', '{"x": 0.00000000000005684341886080803}')).toBe(false);
    expect(sameJson('[1, "a b", true, null]', '[1,"a b",true,null]')).toBe(true);
    expect(sameJson('{"n": 12345678901234567890}', '{"n": 12345678901234567891}')).toBe(false);
    expect(sameJson('"a"', '"b"')).toBe(false);
    expect(sameJson(null, null)).toBe(true);
    expect(sameJson('{}', null)).toBe(false);
  });

  it('writes fractional numbers through CAST(... AS DOUBLE)', () => {
    expect(jsonCell('{"a": 1}')).toEqual({ sql: '?', params: ['{"a": 1}'] });
    expect(jsonCell(null)).toEqual({ sql: '?', params: [null] });
    expect(jsonCell('{"a": 0.1, "b": [2.5]}')).toEqual({
      sql: 'JSON_SET(?, ?, CAST(? AS DOUBLE), ?, CAST(? AS DOUBLE))',
      params: ['{"a": 0.1, "b": [2.5]}', '$."a"', '0.1', '$."b"[0]', '2.5'],
    });
  });
});
