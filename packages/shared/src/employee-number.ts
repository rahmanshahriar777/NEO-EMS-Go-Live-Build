/**
 * Employee number generation (go-live Phase 1 item 6).
 *
 * Canonical format: EMP-YYYY-NNNN (e.g. EMP-2026-0042). Numbers come from the
 * Postgres sequence `employee_number_seq` (migration
 * 20261005140000_employee_number_seq), seeded above the highest numeric
 * suffix already in the table — never `count() + 1`, never a MAX() probe, so
 * concurrent creations cannot collide.
 *
 * Both creation paths (employees.service.create and the recruitment
 * offer-accept auto-create) format through this module.
 */

/** Format a sequence value as EMP-YYYY-NNNN. */
export function formatEmployeeNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`formatEmployeeNumber: invalid year ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`formatEmployeeNumber: invalid sequence ${sequence}`);
  }
  return `EMP-${year}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Fetch the next sequence value and format it. `queryRaw` is the caller's
 * raw-query entry point (e.g. `(sql) => prisma.$queryRawUnsafe(sql)` or the
 * transaction client's equivalent) — the shared package takes no Prisma
 * dependency. Throws (never fabricates) when the sequence is missing, so a
 * skipped migration fails loud instead of minting a duplicate number.
 */
export async function nextEmployeeNumber(
  queryRaw: (sql: string) => Promise<unknown>,
  year: number = new Date().getFullYear(),
): Promise<string> {
  const rows = (await queryRaw(
    `SELECT nextval('employee_number_seq') AS n`,
  )) as Array<{ n: unknown }> | null | undefined;
  const n = Number((rows as Array<{ n: unknown }>)?.[0]?.n);
  if (!Number.isFinite(n)) {
    throw new Error(
      'nextEmployeeNumber: employee_number_seq returned no value — ' +
        'migration 20261005140000_employee_number_seq has not been applied',
    );
  }
  return formatEmployeeNumber(year, n);
}
