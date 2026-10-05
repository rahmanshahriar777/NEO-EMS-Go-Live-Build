import { SystemRole } from '@ems/shared';
import { canViewCompensation, sanitizeEmployee } from './sanitize.util';

describe('canViewCompensation', () => {
  it('allows HR_ADMIN and SUPER_ADMIN', () => {
    expect(canViewCompensation([SystemRole.HR_ADMIN])).toBe(true);
    expect(canViewCompensation([SystemRole.SUPER_ADMIN])).toBe(true);
    expect(canViewCompensation([SystemRole.EMPLOYEE, SystemRole.HR_ADMIN])).toBe(true);
  });

  it('denies managers, employees, and missing roles', () => {
    expect(canViewCompensation([SystemRole.MANAGER])).toBe(false);
    expect(canViewCompensation([SystemRole.EMPLOYEE])).toBe(false);
    expect(canViewCompensation([])).toBe(false);
    expect(canViewCompensation(undefined)).toBe(false);
  });
});

describe('sanitizeEmployee', () => {
  const full = {
    id: 'emp-1',
    firstName: 'Jane',
    salaryStructures: [{ baseSalary: 5000 }],
    bankAccountEnc: 'enc-bank',
    taxIdEnc: 'enc-tax',
  };

  it('returns the payload untouched for HR/admin', () => {
    const out = sanitizeEmployee(full, [SystemRole.HR_ADMIN]) as typeof full;
    expect(out.salaryStructures).toBeDefined();
    expect(out.bankAccountEnc).toBe('enc-bank');
  });

  it('strips compensation and encrypted identifiers for others', () => {
    const out = sanitizeEmployee(full, [SystemRole.MANAGER]) as Record<string, any>;
    expect(out.firstName).toBe('Jane');
    expect(out).not.toHaveProperty('salaryStructures');
    expect(out).not.toHaveProperty('bankAccountEnc');
    expect(out).not.toHaveProperty('taxIdEnc');
  });

  it('does not mutate the input', () => {
    sanitizeEmployee(full, [SystemRole.EMPLOYEE]);
    expect(full.salaryStructures).toBeDefined();
  });
});
