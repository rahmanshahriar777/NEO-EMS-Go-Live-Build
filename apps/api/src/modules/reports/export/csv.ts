/**
 * Minimal CSV writer (RFC 4180).
 *
 * Dependency-free: quotes fields containing commas, quotes, CR or LF, and
 * doubles embedded quotes. Numbers/booleans are stringified as-is; nullish
 * values become empty fields.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);

  // Formula injection guard (CSV injection):
  // Prefix fields starting with =, +, -, @, or tab/CR with a single quote (')
  // so spreadsheet applications treat them as text literals rather than formulas.
  // Numeric types (typeof number) are preserved unless formatted as string expressions.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }

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
