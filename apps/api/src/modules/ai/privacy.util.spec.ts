import { redactPii, redactNames, redactSalaries, redactAddresses, excerpt } from './privacy.util';

describe('AI PII redaction (widened)', () => {
  it('redacts known person names whole-word, case-insensitive', () => {
    const out = redactNames('Ada Lovelace met ada at the ADA conference', ['Ada Lovelace']);
    expect(out).not.toContain('Ada');
    expect(out).toContain('[REDACTED_NAME]');
    // Unrelated words survive.
    expect(redactNames('Adapt to change', ['Ada'])).toContain('Adapt');
  });

  it('redacts salary figures: £, GBP, and keyword-adjacent amounts', () => {
    expect(redactSalaries('Salary is £45,000 per year')).toContain('[REDACTED_SALARY]');
    expect(redactSalaries('Salary is £45,000 per year')).not.toContain('45,000');
    expect(redactSalaries('GBP 120000 bonus')).toContain('[REDACTED_SALARY]');
    expect(redactSalaries('salary of 95000')).toContain('[REDACTED_SALARY]');
    expect(redactSalaries('compensation: 80000')).toContain('[REDACTED_SALARY]');
    // Bare numbers without currency/keywords are left alone.
    expect(redactSalaries('There are 5 people in the team')).toContain('5 people');
    // Common prose with "pay" is not nuked.
    expect(redactSalaries('Pay attention to 5 things')).toContain('5 things');
  });

  it('redacts street addresses and PO boxes', () => {
    expect(redactAddresses('Lives at 12 High Street, London')).toContain('[REDACTED_ADDRESS]');
    expect(redactAddresses('Lives at 12 High Street, London')).not.toContain('High Street');
    expect(redactAddresses('Flat 4, 10 Church Lane')).toContain('[REDACTED_ADDRESS]');
    expect(redactAddresses('PO Box 123')).toContain('[REDACTED_ADDRESS]');
  });

  it('redactPii combines shared + widened redaction with caller names', () => {
    const out = redactPii(
      'Ada Lovelace (ada@example.com, NI QQ123456C) earns £95,000, lives at 12 High Street.',
      { names: ['Ada Lovelace'] },
    );
    expect(out).not.toContain('Ada');
    expect(out).not.toContain('ada@example.com');
    expect(out).not.toContain('QQ123456C');
    expect(out).not.toContain('95,000');
    expect(out).not.toContain('High Street');
    expect(out).toContain('[REDACTED_NAME]');
    expect(out).toContain('[REDACTED_SALARY]');
    expect(out).toContain('[REDACTED_ADDRESS]');
  });

  it('redactPii without names still applies pattern redaction', () => {
    const out = redactPii('Contact bob@example.com about the £50k budget.');
    expect(out).not.toContain('bob@example.com');
    expect(out).not.toContain('£50');
  });

  it('excerpt truncates long text', () => {
    expect(excerpt('x'.repeat(600), 500)).toHaveLength(501); // 500 + ellipsis
    expect(excerpt('short')).toBe('short');
  });
});
