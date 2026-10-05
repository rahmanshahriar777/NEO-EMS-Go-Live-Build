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

/**
 * Floor for the employee_number_seq seed value (go-live HIGH #8).
 *
 * Mirrors migration 20261005140000_employee_number_seq:
 *   SELECT setval('employee_number_seq',
 *     GREATEST(999, COALESCE(MAX(trailing digits of employeeNumber), 0)))
 * Seeded demo employees occupy EMP-YYYY-0001..0020, so the sequence must
 * effectively start at 1000 — without the floor, the first app-created
 * employee would re-issue EMP-YYYY-0001 and hit the UNIQUE constraint.
 */
export const EMPLOYEE_NUMBER_SEQUENCE_FLOOR = 999;

/**
 * Trailing digit run of an employee number: EMP-2026-0042 -> 42,
 * EMP-12345 (legacy recruitment format) -> 12345. Returns null when the
 * value has no trailing digits. Matches the migration's
 * SUBSTRING("employeeNumber" FROM '[0-9]+$').
 */
export function trailingEmployeeDigits(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure JS mirror of the migration's setval computation: the value the
 * sequence must be seeded to given the employee numbers already in the
 * table — never below EMPLOYEE_NUMBER_SEQUENCE_FLOOR, never below the
 * highest trailing digit run. Unit-tested in employee-number.test.ts.
 */
export function computeEmployeeNumberSequenceSeed(
  employeeNumbers: Iterable<string | null | undefined>,
): number {
  let max = EMPLOYEE_NUMBER_SEQUENCE_FLOOR;
  for (const n of employeeNumbers) {
    const t = trailingEmployeeDigits(n);
    if (t !== null && t > max) max = t;
  }
  return max;
}

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
  // nextval() always yields a positive integer; anything else (empty rows,
  // null, NaN) means the sequence is missing or broken — never fabricate.
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      'nextEmployeeNumber: employee_number_seq returned no value — ' +
        'migration 20261005140000_employee_number_seq has not been applied',
    );
  }
  return formatEmployeeNumber(year, n);
}
