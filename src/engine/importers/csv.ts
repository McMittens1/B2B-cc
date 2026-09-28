import Papa from 'papaparse';

/**
 * Delimited text (CSV, TSV, semicolon- or pipe-separated) as rows of string cells.
 *
 * Papa Parse handles quoting and line endings. Its own delimiter guess is thrown
 * off by the single-cell title lines payroll exports put above the header, so the
 * delimiter is chosen here: the one that gives the most rows the same field count.
 */

const DELIMITERS = [',', ';', '\t', '|'] as const;
const SAMPLE_CHARS = 64 * 1024;

export function parseCsvText(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  if (clean.trim() === '') return [];
  const result = Papa.parse<string[]>(clean, {
    delimiter: guessDelimiter(clean),
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
  });
  const rows = result.data.map((row) => (Array.isArray(row) ? row.map((c) => (typeof c === 'string' ? c : '')) : []));
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === '')) rows.pop();
  return rows;
}

/** The delimiter that splits the most sample rows into the same number (≥ 2) of fields. */
export function guessDelimiter(text: string): string {
  const sample = text.slice(0, SAMPLE_CHARS);
  let best: string = DELIMITERS[0];
  let bestRows = 0;
  let bestWidth = 0;
  for (const delimiter of DELIMITERS) {
    const { data } = Papa.parse<string[]>(sample, { delimiter, preview: 60, skipEmptyLines: true });
    const frequency = new Map<number, number>();
    for (const row of data) {
      if (Array.isArray(row) && row.length > 1) frequency.set(row.length, (frequency.get(row.length) ?? 0) + 1);
    }
    for (const [width, rows] of frequency) {
      if (rows > bestRows || (rows === bestRows && width > bestWidth)) {
        best = delimiter;
        bestRows = rows;
        bestWidth = width;
      }
    }
  }
  return best;
}

/**
 * Decode file bytes as text: UTF-16 when it has a byte-order mark (Excel's
 * "Unicode Text" export), UTF-8 when valid, otherwise Windows-1252, which older
 * accounting packages still write.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  if (looksLikeUtf16le(data)) return new TextDecoder('utf-16le').decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(data);
    } catch {
      return new TextDecoder('utf-8').decode(data);
    }
  }
}

/** UTF-16LE text without a byte-order mark: every other byte is zero. */
export function looksLikeUtf16le(data: Uint8Array): boolean {
  const n = Math.min(data.length, 512) & ~1;
  if (n < 8) return false;
  let zeros = 0;
  for (let i = 1; i < n; i += 2) if (data[i] === 0 && data[i - 1] !== 0) zeros++;
  return zeros > n / 2 * 0.8;
}
