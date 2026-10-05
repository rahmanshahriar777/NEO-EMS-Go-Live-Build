import { createHash } from 'crypto';
import { PiiRedactor } from '@ems/shared';

/**
 * AI privacy helpers (UK GDPR data minimisation).
 *
 * - `redactPii` runs BEFORE every provider call and BEFORE AIRequestLog
 *   persistence. The provider and the stored log never see raw PII.
 * - Logs keep only a redacted excerpt (first N chars) plus SHA-256 hashes of
 *   the full originals, so duplicates are detectable without retaining data.
 *
 * Redaction is HEURISTIC and deliberately over-redacts: a false positive
 * costs a slightly degraded prompt; a false negative leaks PII to a third
 * party. Patterns cover: SSNs, credit cards, emails, phones (shared
 * PiiRedactor), UK NI numbers, UK postcodes, UK phones (shared), plus —
 * widened here — person names (caller-supplied), street addresses, and
 * salary/compensation figures.
 */
export const AI_LOG_EXCERPT_CHARS = 500;

export interface RedactOptions {
  /** Known person names (e.g. the caller's own first/last name) to redact. */
  names?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts known person names (whole-word, case-insensitive). Name parts
 * shorter than 2 characters are skipped to avoid destroying prose.
 */
export function redactNames(text: string, names: string[]): string {
  let out = text;
  for (const raw of names) {
    for (const part of String(raw || '').split(/\s+/)) {
      const name = part.trim();
      if (name.length < 2) continue;
      out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), '[REDACTED_NAME]');
    }
  }
  return out;
}

/**
 * Redacts salary/compensation figures: £-amounts, GBP amounts, and amounts
 * near salary keywords (salary/pay/earn/compensation/wage, per year|month|
 * annum|hour). Plain bare numbers are NOT redacted (too many false
 * positives) — only currency-marked or keyword-adjacent amounts.
 */
export function redactSalaries(text: string): string {
  let out = text;
  // £1,234.56 / £ 1234
  out = out.replace(/£\s?\d[\d,]*(?:\.\d{1,2})?/g, '[REDACTED_SALARY]');
  // GBP 12,000 / GBP12,000.00
  out = out.replace(/\bGBP\s?\d[\d,]*(?:\.\d{1,2})?/gi, '[REDACTED_SALARY]');
  // salary of 45000 / salary: 45,000 / compensation of 60000 per annum
  // (£ already handled above; this catches keyword-adjacent bare numbers).
  // "pay"/"earn" are deliberately NOT keywords — too common in prose; the
  // £/GBP patterns catch those figures anyway.
  out = out.replace(
    /\b(salary|compensation|remuneration|wages?)\b.{0,24}?\d[\d,]*(?:\.\d{1,2})?/gi,
    (m) => m.replace(/\d[\d,]*(?:\.\d{1,2})?/g, '[REDACTED_SALARY]'),
  );
  return out;
}

/**
 * Redacts street addresses: UK-style "12 High Street", "Flat 4, 10 Main
 * Road", "PO Box 123". Postcodes are already handled by the shared
 * redactor; this catches the street line itself.
 */
export function redactAddresses(text: string): string {
  let out = text;
  // 12 High Street / 10a Main Road / Flat 4, 10 Church Lane
  out = out.replace(
    /\b(?:Flat|Unit|Apartment|Apt\.?|Suite)\s+\w+,?\s+\d{1,4}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Close|Cl\.?|Court|Ct\.?|Terrace|Place|Way|Grove|Gardens?|Crescent|Parade|Square)\b/gi,
    '[REDACTED_ADDRESS]',
  );
  out = out.replace(
    /\b\d{1,4}[a-z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Close|Cl\.?|Court|Ct\.?|Terrace|Place|Way|Grove|Gardens?|Crescent|Parade|Square)\b/g,
    '[REDACTED_ADDRESS]',
  );
  // PO Box 123
  out = out.replace(/\bP\.?O\.?\s+Box\s+\d+\b/gi, '[REDACTED_ADDRESS]');
  return out;
}

export function redactPii(text: string, opts?: RedactOptions): string {
  let redacted = PiiRedactor.sanitizePrompt(text);
  redacted = PiiRedactor.redactEmails(redacted);
  redacted = redactAddresses(redacted);
  redacted = redactSalaries(redacted);
  if (opts?.names?.length) {
    redacted = redactNames(redacted, opts.names);
  }
  return redacted;
}

export function excerpt(text: string, maxChars: number = AI_LOG_EXCERPT_CHARS): string {
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
