import { APP_TIMEZONE, APP_LOCALE, APP_CURRENCY } from './env';

/**
 * Date/time and currency formatting helpers.
 *
 * The display timezone, locale and currency all come from environment
 * configuration (`NEXT_PUBLIC_TIMEZONE`, `NEXT_PUBLIC_LOCALE`,
 * `NEXT_PUBLIC_CURRENCY`) with UK defaults (Europe/London, en-GB, GBP).
 * No timezone or currency is hardcoded anywhere in the UI.
 */

function toDate(date: Date | string): Date | null {
  const d = typeof date === 'string' ? new Date(date) : date;
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date/ISO string into a time string (HH:MM:SS AM/PM) in the app timezone. */
export function formatAppTime(date: Date | string = new Date()): string {
  const d = toDate(date);
  if (!d) return '--:--:--';
  try {
    return d.toLocaleTimeString(APP_LOCALE === 'en-GB' ? 'en-GB' : 'en-US', {
      timeZone: APP_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return '--:--:--';
  }
}

/** Format a Date/ISO string into a date string (e.g. Mon, 15 Sep 2026) in the app timezone. */
export function formatAppDate(date: Date | string = new Date()): string {
  const d = toDate(date);
  if (!d) return '--/--/----';
  try {
    return d.toLocaleDateString(APP_LOCALE, {
      timeZone: APP_TIMEZONE,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '--/--/----';
  }
}

/** Format full date and time string in the app timezone. */
export function formatAppDateTime(date: Date | string = new Date()): string {
  return `${formatAppDate(date)} • ${formatAppTime(date)}`;
}

/** Format a monetary amount in the configured currency (GBP default). */
export function formatCurrency(amount: number | string | null | undefined, opts?: { decimals?: number }): string {
  const n = Number(amount);
  if (!isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(APP_LOCALE, {
      style: 'currency',
      currency: APP_CURRENCY,
      minimumFractionDigits: opts?.decimals ?? 2,
      maximumFractionDigits: opts?.decimals ?? 2,
    }).format(n);
  } catch {
    return `${APP_CURRENCY} ${n.toLocaleString()}`;
  }
}

/** Short currency label, e.g. "GBP". */
export function currencyLabel(): string {
  return APP_CURRENCY;
}

/** The configured display timezone, for labels such as "Europe/London". */
export function timezoneLabel(): string {
  return APP_TIMEZONE;
}
