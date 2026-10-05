import { ApiResponse, PaginatedResponse, ApiErrorResponse, PaginationMeta } from '../types/index.js';

/**
 * Default display currency. Configurable via the DEFAULT_CURRENCY env var so
 * deployments can localise without code changes; falls back to GBP.
 * (F27: the old hardcoded 'BDT' default made UK payroll impossible without
 * code changes.)
 */
export const DEFAULT_CURRENCY: string =
  (typeof process !== 'undefined' && process.env?.DEFAULT_CURRENCY) || 'GBP';

/**
 * Monetary arithmetic utilities using integer representation (cents/minor units) to avoid floating-point issues.
 */
export const CurrencyUtil = {
  toMinorUnits(amount: number): number {
    return Math.round(amount * 100);
  },

  fromMinorUnits(cents: number): number {
    return Number((cents / 100).toFixed(2));
  },

  format(amount: number, currency: string = DEFAULT_CURRENCY): string {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
    }).format(amount);
  },

  calculateComponent(base: number, calculationType: string, value: number): number {
    if (calculationType === 'FIXED') {
      return value;
    }
    // Percentage
    return Number(((base * value) / 100).toFixed(2));
  },
};

/**
 * Date and time calculations
 */
export const DateUtil = {
  formatIso(date: Date | string): string {
    return new Date(date).toISOString();
  },

  formatDateOnly(date: Date | string): string {
    const d = new Date(date);
    return d.toISOString().split('T')[0];
  },

  calculateDaysBetween(startDate: string | Date, endDate: string | Date): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // inclusive
  },

  calculateHoursWorked(clockIn: Date | string, clockOut: Date | string): number {
    const start = new Date(clockIn).getTime();
    const end = new Date(clockOut).getTime();
    const hours = (end - start) / (1000 * 60 * 60);
    return Number(Math.max(0, hours).toFixed(2));
  },

  /**
   * England & Wales bank holidays for a given year, as ISO date strings.
   *
   * ASSUMPTION (documented per contract): computed from the standard
   * recurring set (New Year's Day, Good Friday, Easter Monday, Early May,
   * Spring, Summer bank holidays, Christmas Day, Boxing Day) with the usual
   * substitute-weekday rules. One-off royal-event holidays (e.g. coronations,
   * state funerals) are NOT included. For production payroll/leave math,
   * reconcile against the official gov.uk bank-holidays feed for the year.
   */
  getEnglandWalesBankHolidays(year: number): string[] {
    const iso = (d: Date): string => d.toISOString().split('T')[0];
    const holidays: Date[] = [];

    const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const nextMonday = (d: Date) => {
      const c = new Date(d);
      c.setUTCDate(c.getUTCDate() + ((8 - c.getUTCDay()) % 7 || 7));
      return c;
    };

    // New Year's Day (+ substitute when it falls on a weekend)
    const newYear = new Date(Date.UTC(year, 0, 1));
    if (isWeekend(newYear)) {
      holidays.push(nextMonday(newYear));
    } else {
      holidays.push(newYear);
    }

    // Easter (computus, Gregorian)
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const easterMonth = Math.floor((h + l - 7 * m + 114) / 31) - 1;
    const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
    const easterSunday = new Date(Date.UTC(year, easterMonth, easterDay));
    const goodFriday = new Date(easterSunday);
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
    const easterMonday = new Date(easterSunday);
    easterMonday.setUTCDate(easterMonday.getUTCDate() + 1);
    holidays.push(goodFriday, easterMonday);

    // Early May: first Monday in May
    const earlyMay = new Date(Date.UTC(year, 4, 1));
    while (earlyMay.getUTCDay() !== 1) earlyMay.setUTCDate(earlyMay.getUTCDate() + 1);
    holidays.push(earlyMay);

    // Spring: last Monday in May
    const spring = new Date(Date.UTC(year, 4, 31));
    while (spring.getUTCDay() !== 1) spring.setUTCDate(spring.getUTCDate() - 1);
    holidays.push(spring);

    // Summer: last Monday in August
    const summer = new Date(Date.UTC(year, 7, 31));
    while (summer.getUTCDay() !== 1) summer.setUTCDate(summer.getUTCDate() - 1);
    holidays.push(summer);

    // Christmas Day and Boxing Day (+ substitutes).
    // Substitutes are resolved together so they can never collide with each
    // other or with the other day: e.g. 2022 (Christmas Sunday) observes
    // Boxing Day on Mon 26th and Christmas on Tue 27th.
    const christmas = new Date(Date.UTC(year, 11, 25));
    const boxing = new Date(Date.UTC(year, 11, 26));
    if (!isWeekend(christmas)) holidays.push(christmas);
    if (!isWeekend(boxing)) holidays.push(boxing);
    const christmasSubs: Date[] = [];
    if (isWeekend(christmas)) christmasSubs.push(nextMonday(christmas));
    if (isWeekend(boxing)) christmasSubs.push(nextMonday(boxing));
    for (const sub of christmasSubs) {
      while (holidays.some((h) => h.getTime() === sub.getTime())) {
        sub.setUTCDate(sub.getUTCDate() + 1);
      }
      holidays.push(sub);
    }

    return [...new Set(holidays.map(iso))].sort();
  },

  /**
   * Working days between two dates (inclusive), excluding weekends and the
   * given holidays (ISO date strings). Defaults to England & Wales bank
   * holidays for each year spanned by the range.
   */
  calculateWorkingDaysBetween(
    startDate: string | Date,
    endDate: string | Date,
    holidays?: string[],
  ): number {
    let start = new Date(startDate);
    let end = new Date(endDate);
    if (start > end) [start, end] = [end, start];
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

    const holidaySet = new Set<string>();
    if (holidays) {
      for (const h of holidays) holidaySet.add(h);
    } else {
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
        for (const h of DateUtil.getEnglandWalesBankHolidays(y)) holidaySet.add(h);
      }
    }

    let workingDays = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const day = cursor.getUTCDay();
      const isWeekend = day === 0 || day === 6;
      if (!isWeekend && !holidaySet.has(cursor.toISOString().split('T')[0])) {
        workingDays++;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return workingDays;
  },
};

/**
 * Convenience snapshot: England & Wales bank holidays for the current
 * calendar year. Prefer getEnglandWalesBankHolidays(year) for explicitness.
 */
export const UK_BANK_HOLIDAYS: readonly string[] = DateUtil.getEnglandWalesBankHolidays(
  new Date().getUTCFullYear(),
);

/**
 * PII Redactor for privacy safety and audit logs
 */
export const PiiRedactor = {
  redactSsn(text: string): string {
    return text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]');
  },

  redactCreditCards(text: string): string {
    return text.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED_CARD]');
  },

  redactEmails(text: string): string {
    return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g, '[REDACTED_EMAIL]');
  },

  redactPhones(text: string): string {
    return text.replace(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
  },

  /**
   * UK National Insurance number, e.g. "QQ 12 34 56 C" or "AB123456C".
   * Deliberately permissive on the letter classes: a redactor should
   * over-redact rather than leak a real NI number because of an edge-case
   * prefix rule.
   */
  redactNationalInsuranceNumber(text: string): string {
    return text.replace(
      /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/gi,
      '[REDACTED_NI_NUMBER]',
    );
  },

  /**
   * UK postcode, e.g. "SW1A 1AA" or "M1 1AE". Case-insensitive; the space is
   * optional in free text.
   */
  redactUKPostcode(text: string): string {
    return text.replace(
      /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
      '[REDACTED_POSTCODE]',
    );
  },

  /**
   * UK phone numbers: mobiles (07xxx xxx xxx / +44 7xxx xxx xxx) and generic
   * +44 landline formats. Runs before the US-centric redactPhones so UK
   * formats are caught first.
   */
  redactUKPhones(text: string): string {
    return text
      .replace(/\b(?:\+44\s?|0)7\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[REDACTED_UK_PHONE]')
      .replace(/\b\+44\s?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, '[REDACTED_UK_PHONE]');
  },

  sanitizePrompt(text: string): string {
    let sanitized = text;
    sanitized = this.redactSsn(sanitized);
    sanitized = this.redactCreditCards(sanitized);
    sanitized = this.redactNationalInsuranceNumber(sanitized);
    sanitized = this.redactUKPostcode(sanitized);
    sanitized = this.redactUKPhones(sanitized);
    sanitized = this.redactPhones(sanitized);
    return sanitized;
  },
};

/**
 * Standard API response builders
 */
export function createSuccessResponse<T>(data: T, message?: string, meta?: Record<string, any>): ApiResponse<T> {
  return {
    success: true,
    message,
    data,
    meta,
    timestamp: new Date().toISOString(),
  };
}

export function createPaginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): ApiResponse<PaginatedResponse<T>> {
  const totalPages = Math.ceil(total / limit) || 1;
  const meta: PaginationMeta = {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };

  return {
    success: true,
    data: {
      items,
      meta,
    },
    timestamp: new Date().toISOString(),
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  statusCode: number = 400,
  details?: any,
  path?: string,
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      statusCode,
      details,
      timestamp: new Date().toISOString(),
      path,
    },
  };
}
