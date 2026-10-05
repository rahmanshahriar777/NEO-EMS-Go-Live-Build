/**
 * Currency precision (ISO 4217 minor units) for payroll money math.
 *
 * Money math boundary: Prisma `Decimal` values NEVER cross a float
 * (`Number(decimal) * factor; Math.round(...)`) boundary on the way into the
 * shared payroll math. Callers pass the Decimal's canonical string
 * (`.toString()`) and it is parsed digit-by-digit into integer minor units
 * below — exact for zero-decimal (JPY, KRW), two-decimal, and three-decimal
 * (KWD, BHD, OMR) currencies. Plain `number` inputs are converted through
 * their shortest decimal representation first, so `toMinorUnits` is
 * string-based in all cases; the only float fallback is for non-decimal
 * string forms (e.g. scientific notation), which money amounts never take.
 *
 * The old CurrencyUtil hardcoded 100 minor units, which is wrong for
 * zero-decimal and three-decimal currencies. These helpers parameterise
 * precision by currency code.
 *
 * DEFAULT assumption: unknown currencies use 2 minor units. Override per
 * deployment via PAYROLL_CURRENCY (validated at startup) and extend this map
 * when the business operates in a non-listed currency.
 */

export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  GBP: 2,
  EUR: 2,
  USD: 2,
  BDT: 2,
  INR: 2,
  PKR: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  CAD: 2,
  AUD: 2,
  SGD: 2,
  MYR: 2,
  CNY: 2,
  // Zero-decimal currencies (ISO 4217).
  JPY: 0,
  KRW: 0,
  VND: 0,
  // Three-decimal currencies (ISO 4217).
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  LYD: 3,
};

/** Minor units for a currency; defaults to 2 for unlisted codes. */
export function minorUnitsFor(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency.toUpperCase()];
  return units === undefined ? 2 : units;
}

function factorFor(currency: string): number {
  return 10 ** minorUnitsFor(currency);
}

/**
 * Convert a major-unit amount to integer minor units, parsed from the exact
 * decimal STRING (e.g. a Prisma Decimal's `.toString()`). No floating-point
 * arithmetic is involved: the digits are scaled and rounded half-up at the
 * currency's precision.
 *
 * Throws on non-finite input, negatives, or strings that are not plain
 * decimals — money math never silently rounds garbage.
 */
export function toMinorUnitsExact(amount: string, currency: string): number {
  const precision = minorUnitsFor(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) {
    throw new Error(`toMinorUnitsExact: not a plain decimal '${amount}' (${currency})`);
  }
  const [, sign, intPart, fracPart = ''] = match;
  if (sign) {
    throw new Error(`toMinorUnitsExact: negative amount '${amount}' (${currency})`);
  }
  // Keep one extra digit for round-half-up, then drop it.
  const frac = `${fracPart}${'0'.repeat(precision + 1)}`.slice(0, precision + 1);
  const digits = `${intPart}${frac.slice(0, precision)}`;
  let minor = digits === '' ? 0 : Number(digits);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`toMinorUnitsExact: amount out of safe range '${amount}' (${currency})`);
  }
  const roundDigit = Number(frac[precision] ?? '0');
  if (roundDigit >= 5) minor += 1;
  return minor;
}

/**
 * Convert a major-unit amount (e.g. 1234.56 GBP) to integer minor units.
 *
 * String-based: `number` inputs go through their shortest decimal
 * representation (`String(amount)`), so values that arrived as floats are
 * parsed from the decimal the caller actually meant, not from a binary
 * product. A non-decimal string form (scientific notation like `1e+21`)
 * falls back to the legacy `Math.round(amount * factor)` path — money
 * amounts never take this path in practice.
 */
export function toMinorUnits(amount: number | string, currency: string): number {
  if (typeof amount === 'string') {
    return toMinorUnitsExact(amount, currency);
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`toMinorUnits: invalid amount ${amount} (${currency})`);
  }
  const decimal = String(amount);
  if (/^\d+(?:\.\d+)?$/.test(decimal)) {
    return toMinorUnitsExact(decimal, currency);
  }
  // Fallback: non-decimal string forms (e.g. 1e+21). Not exact, but the
  // input was already a float with no better representation available.
  return Math.round(amount * factorFor(currency));
}

/** Convert integer minor units back to a major-unit amount. */
export function fromMinorUnits(minorUnits: number, currency: string): number {
  if (!Number.isInteger(minorUnits) || minorUnits < 0) {
    throw new Error(`fromMinorUnits: invalid minor units ${minorUnits} (${currency})`);
  }
  const precision = minorUnitsFor(currency);
  return Number((minorUnits / factorFor(currency)).toFixed(precision));
}

/** Locale-aware display formatting for a major-unit amount. */
export function formatMoney(amount: number, currency: string, locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnitsFor(currency),
    maximumFractionDigits: minorUnitsFor(currency),
  }).format(amount);
}
