/**
 * create-first-admin bootstrap — employee-number regression test (v6 fix #2).
 *
 * The production bootstrap script mints the first admin's employee number.
 * It must use the Postgres `employee_number_seq` via the shared
 * `nextEmployeeNumber` helper — the same path as employees.service and
 * recruitment offer-accept. The old `count() + 1` scheme collides with
 * seeded (EMP-YYYY-0001..0020) and app-created numbers, and races under
 * concurrency.
 *
 * This is a source-contract test, deliberately: the script is a standalone
 * ts-node entry point with an unconditional top-level `main()` invocation,
 * so importing it in-process would execute the bootstrap against a real
 * database. The behavioural surface of the helper itself (sequence-backed,
 * EMP-YYYY-NNNN format, throws instead of fabricating when the sequence is
 * missing) is unit-tested in @ems/shared (employee-number.test.ts); this
 * test guards the wiring — the exact regression the v6 review flagged.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'create-first-admin.ts');

describe('create-first-admin employee numbering (v6 fix #2)', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  });

  it('mints the admin employee number via the shared sequence helper', () => {
    expect(source).toContain('nextEmployeeNumber');
    // The helper is invoked with a raw-query entry point — the same call
    // shape as the other three creation paths — not with a row count.
    expect(source).toMatch(/nextEmployeeNumber\(\s*\(sql: string\)/);
    expect(source).toContain("@ems/shared");
  });

  it('no longer derives the number from employee.count()', () => {
    expect(source).not.toMatch(/employee\.count\(\)/);
    expect(source).not.toMatch(/count\s*\+\s*1/);
  });
});
