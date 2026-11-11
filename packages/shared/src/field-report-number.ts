/**
 * Sequential human-readable field report numbers: FR-YYYY-NNNN.
 * Uses PostgreSQL sequence `field_report_number_seq` (migration 20261111000000_field_reporting)
 * so concurrent creations never collide.
 */

export function formatFieldReportNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`formatFieldReportNumber: invalid year ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`formatFieldReportNumber: invalid sequence ${sequence}`);
  }
  return `FR-${year}-${String(sequence).padStart(4, '0')}`;
}

export async function nextFieldReportNumber(
  queryRaw: (sql: string) => Promise<unknown>,
  year: number = new Date().getFullYear(),
): Promise<string> {
  const rows = (await queryRaw(
    `SELECT nextval('field_report_number_seq') AS n`,
  )) as Array<{ n: unknown }> | null | undefined;
  const n = Number(rows?.[0]?.n);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      'nextFieldReportNumber: field_report_number_seq returned no value — ' +
        'migration 20261111000000_field_reporting has not been applied',
    );
  }
  return formatFieldReportNumber(year, n);
}

