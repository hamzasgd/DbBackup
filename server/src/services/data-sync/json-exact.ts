/**
 * JSON values with exact numbers.
 *
 * MySQL stores a JSON number with a fraction as a binary double, and its JSON
 * text parser does not always pick the nearest double: MySQL 8.4.13 reads
 * 5.684341886080802e-14 as 5.684341886080803e-14. Writing a JSON column from
 * its text therefore changed such numbers in the last bit, every time. Its
 * number parser (CAST(... AS DOUBLE)) is exact, so those numbers are set again
 * with JSON_SET after the text is read.
 *
 * Servers also print the same double differently (8.4.8: 5.684341886080802e-14,
 * 8.4.13: 0.00000000000005684341886080802), so comparing JSON as text sees a
 * difference where there is none: canonicalJson() writes every fractional
 * number in one form, for comparing.
 */

interface Scan {
  /** The value with insignificant whitespace removed and fractional numbers in one form */
  canonical: string;
  /** Paths (MySQL syntax) and text of numbers with a fraction or exponent */
  fractions: { path: string; text: string }[];
}

const isFraction = (num: string) => /[.eE]/.test(num);

/** One form for a fractional number: JavaScript's shortest text for the same double */
const canonicalNumber = (num: string) => (isFraction(num) ? String(Number(num)) : num.replace(/^-0$/, '0'));

/** Walk a JSON text (as MySQL prints it); null when it isn't valid JSON. */
export function scanJson(text: string): Scan | null {
  let i = 0;
  const fractions: Scan['fractions'] = [];
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new Error('unterminated string');
    i++;
    return text.slice(start, i);
  };
  const value = (path: string): string => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const parts: string[] = [];
      ws();
      if (text[i] === '}') { i++; return '{}'; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error('expected a key');
        const key = str();
        ws();
        if (text[i] !== ':') throw new Error('expected :');
        i++;
        parts.push(`${key}:${value(`${path}.${key}`)}`);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        throw new Error('expected , or }');
      }
      return `{${parts.join(',')}}`;
    }
    if (c === '[') {
      i++;
      const parts: string[] = [];
      ws();
      if (text[i] === ']') { i++; return '[]'; }
      for (let n = 0; ; n++) {
        parts.push(value(`${path}[${n}]`));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        throw new Error('expected , or ]');
      }
      return `[${parts.join(',')}]`;
    }
    if (c === '"') return str();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      if (isFraction(m[0])) fractions.push({ path, text: m[0] });
      return canonicalNumber(m[0]);
    }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { i += lit.length; return lit; }
    }
    throw new Error(`unexpected ${c}`);
  };
  try {
    const canonical = value('$');
    ws();
    if (i !== text.length) return null;
    return { canonical, fractions };
  } catch {
    return null;
  }
}

/** Whether two JSON texts hold the same value (fractional numbers compared as doubles). */
export function sameJson(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  const x = scanJson(a);
  const y = scanJson(b);
  return !!x && !!y && x.canonical === y.canonical;
}

/**
 * The SQL for writing a JSON value exactly: the text, then each fractional
 * number set again from MySQL's exact number parser.
 */
export function jsonCell(value: unknown): { sql: string; params: unknown[] } {
  if (typeof value !== 'string') return { sql: '?', params: [value] };
  const scan = scanJson(value);
  if (!scan || scan.fractions.length === 0) return { sql: '?', params: [value] };
  return {
    sql: `JSON_SET(?, ${scan.fractions.map(() => '?, CAST(? AS DOUBLE)').join(', ')})`,
    params: [value, ...scan.fractions.flatMap((f) => [f.path, f.text])],
  };
}
