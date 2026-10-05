/**
 * Minimal CSV writer (RFC 4180).
 *
 * Dependency-free: quotes fields containing commas, quotes, CR or LF, and
 * doubles embedded quotes. Numbers/booleans are stringified as-is; nullish
 * values become empty fields.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(escapeCsvField).join(','),
    ...rows.map((row) => row.map(escapeCsvField).join(',')),
  ];
  // CRLF line endings per RFC 4180; Excel-friendly.
  return lines.join('\r\n') + '\r\n';
}
