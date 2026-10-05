/**
 * AI document intelligence — heuristic field/expiry extraction (Phase 3,
 * item 8, stretch).
 *
 * Small, dependency-free heuristics run at upload time over text-extractable
 * content. They never fabricate: every extraction returns the matched source
 * text and a confidence level, and the caller decides whether to persist.
 * LLM-assisted extraction (via the AI assistant module) can supersede these
 * suggestions — the suggestion object is the shared contract.
 */

export interface ExtractedField {
  field: string;
  value: string;
  /** The raw matched text the value was derived from. */
  sourceText: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DocumentIntelligenceResult {
  fields: ExtractedField[];
  /** Suggested expiry date (YYYY-MM-DD) when an expiry-like date is found. */
  suggestedExpiry?: string;
}

const EXPIRY_PATTERNS: RegExp[] = [
  // "expiry date: 2027-01-15", "expires 15/01/2027", "valid until 2027.01.15"
  /(expir(?:y|ation|es)(?:\s+date)?|valid\s+(?:until|through|to))\s*[:\-]?\s*(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})/i,
  // "policy period ... to 2027-01-15"
  /(?:policy\s+period|coverage\s+period|validity)[\s\S]{0,60}?(?:to|until|through)\s*[:\-]?\s*(\d{4}[-/.]\d{2}[-/.]\d{2})/i,
];

const ISSUE_PATTERNS: RegExp[] = [
  /(?:issue(?:d)?(?:\s+date)?|effective(?:\s+date)?|dated)\s*[:\-]?\s*(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})/i,
];

const IDENTIFIER_PATTERNS: Array<{ field: string; regex: RegExp }> = [
  { field: 'policyNumber', regex: /(?:policy\s*(?:no|number|#))\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,30})/i },
  { field: 'certificateNumber', regex: /(?:certificate\s*(?:no|number|#))\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,30})/i },
  { field: 'contractReference', regex: /(?:contract\s*(?:no|number|ref(?:erence)?|#))\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,30})/i },
];

/** Normalises DD/MM/YYYY, DD-MM-YYYY, YYYY.MM.DD → YYYY-MM-DD. */
export function normalizeDate(raw: string): string | null {
  const iso = raw.match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return isValidCalendarDate(y, m, d) ? `${y}-${m}-${d}` : null;
  }
  const dmy = raw.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return isValidCalendarDate(y, m, d) ? `${y}-${m}-${d}` : null;
  }
  return null;
}

function isValidCalendarDate(y: string, m: string, d: string): boolean {
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() + 1 === Number(m) &&
    date.getUTCDate() === Number(d)
  );
}

/**
 * Extracts fields/expiry from text content. Returns an empty result (no
 * suggestions) when nothing matches — never guesses.
 */
export function extractDocumentFields(text: string): DocumentIntelligenceResult {
  const fields: ExtractedField[] = [];
  const haystack = text.slice(0, 200_000); // bound the scan
  let suggestedExpiry: string | undefined;

  for (const pattern of EXPIRY_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) {
      const normalized = normalizeDate(match[2] ?? match[1]);
      if (normalized) {
        suggestedExpiry = normalized;
        fields.push({
          field: 'expiryDate',
          value: normalized,
          sourceText: match[0].trim().slice(0, 120),
          confidence: 'high',
        });
        break;
      }
    }
  }

  for (const pattern of ISSUE_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) {
      const normalized = normalizeDate(match[1]);
      if (normalized) {
        fields.push({
          field: 'issueDate',
          value: normalized,
          sourceText: match[0].trim().slice(0, 120),
          confidence: 'medium',
        });
        break;
      }
    }
  }

  for (const { field, regex } of IDENTIFIER_PATTERNS) {
    const match = haystack.match(regex);
    if (match) {
      fields.push({
        field,
        value: match[1].trim(),
        sourceText: match[0].trim().slice(0, 120),
        confidence: 'medium',
      });
    }
  }

  return { fields, suggestedExpiry };
}

/**
 * Best-effort text extraction for intelligence purposes. Only decodes buffers
 * that look like text (no NUL bytes, mostly printable); returns null for
 * binary content (PDF/DOCX need a real extractor — reported as follow-up).
 */
export function extractTextForIntelligence(
  buffer: Buffer,
  mimeType: string,
): string | null {
  if (!mimeType.startsWith('text/') && mimeType !== 'application/json') return null;
  if (buffer.includes(0)) return null; // binary masquerading as text
  try {
    const text = buffer.toString('utf8');
    // Reject mostly-non-printable payloads.
    const sample = text.slice(0, 4000);
    const printable = (sample.match(/[\x20-\x7E\s]/g) || []).length;
    if (sample.length > 0 && printable / sample.length < 0.85) return null;
    return text;
  } catch {
    return null;
  }
}
