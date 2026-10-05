import {
  detectUploadMime,
  validateUpload,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from './document-storage.util';
import {
  extractDocumentFields,
  extractTextForIntelligence,
  normalizeDate,
} from './document-intelligence.util';
import { NoopMalwareScanner } from './malware-scanner.interface';

// file-type v22 is ESM-only: production Node loads it via dynamic import(),
// but Jest's CJS transform cannot. This virtual mock reproduces its
// magic-byte contract so the allowlist/fallback logic is genuinely tested.
jest.mock(
  'file-type',
  () => ({
    fileTypeFromBuffer: jest.fn(async (buffer: Buffer) => {
      if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        return { mime: 'application/pdf', ext: 'pdf' };
      }
      const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSig)) {
        return { mime: 'image/png', ext: 'png' };
      }
      if (buffer.subarray(0, 2).toString('latin1') === 'MZ') {
        return { mime: 'application/x-msdownload', ext: 'exe' };
      }
      return undefined; // text / junk: unidentified by magic bytes
    }),
  }),
  { virtual: true },
);

// file-type is declared in package.json (installed by the package-merge
// step) but not yet in this sandbox's node_modules. The content-detection
// tests run wherever the package is installed (CI) and skip otherwise.
let fileTypeInstalled = false;
try {
  require.resolve('file-type');
  fileTypeInstalled = true;
} catch {
  fileTypeInstalled = false;
}
const describeMime = fileTypeInstalled ? describe : describe.skip;

describeMime('detectUploadMime (content-based)', () => {
  it('identifies a PDF by magic bytes, not the claimed type', async () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(100, 'a'),
    ]);
    const result = await detectUploadMime(pdf, 'application/octet-stream', DEFAULT_ALLOWED_MIME_TYPES);
    expect(result.mimeType).toBe('application/pdf');
    expect(result.detected).toBe(true);
  });

  it('identifies a PNG by magic bytes', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100, 0),
    ]);
    const result = await detectUploadMime(png, 'image/jpeg', DEFAULT_ALLOWED_MIME_TYPES);
    expect(result.mimeType).toBe('image/png');
  });

  it('rejects an executable masquerading as a PDF', async () => {
    // MZ header = Windows executable; not in the allowlist.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]);
    await expect(
      detectUploadMime(exe, 'application/pdf', DEFAULT_ALLOWED_MIME_TYPES),
    ).rejects.toThrow(/not allowed/i);
  });

  it('accepts genuine text via the textual fallback', async () => {
    const csv = Buffer.from('name,email\nAda,ada@example.com\n');
    const result = await detectUploadMime(csv, 'text/csv', DEFAULT_ALLOWED_MIME_TYPES);
    expect(result.mimeType).toBe('text/csv');
    expect(result.detected).toBe(false);
  });

  it('rejects binary bytes claimed as text', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]);
    await expect(
      detectUploadMime(binary, 'text/plain', DEFAULT_ALLOWED_MIME_TYPES),
    ).rejects.toThrow(/rejected/i);
  });

  it('rejects unidentifiable content with a non-textual claim', async () => {
    const junk = Buffer.from('plain text without signature');
    await expect(
      detectUploadMime(junk, 'application/pdf', DEFAULT_ALLOWED_MIME_TYPES),
    ).rejects.toThrow(/could not identify/i);
  });
});

describe('validateUpload (coarse gate)', () => {
  it('still rejects disallowed claimed types and oversize files', () => {
    expect(() =>
      validateUpload('application/x-sh', 100, DEFAULT_ALLOWED_MIME_TYPES, DEFAULT_MAX_FILE_SIZE_BYTES),
    ).toThrow(/not allowed/i);
    expect(() =>
      validateUpload('application/pdf', DEFAULT_MAX_FILE_SIZE_BYTES + 1, DEFAULT_ALLOWED_MIME_TYPES, DEFAULT_MAX_FILE_SIZE_BYTES),
    ).toThrow(/exceeds/i);
  });
});

describe('document intelligence (heuristics)', () => {
  it('extracts an expiry date from policy text', () => {
    const text = 'Motor Insurance Policy\nPolicy No: ABC-12345\nExpiry Date: 2027-01-15\nPremium paid.';
    const result = extractDocumentFields(text);
    expect(result.suggestedExpiry).toBe('2027-01-15');
    expect(result.fields).toContainEqual(
      expect.objectContaining({ field: 'expiryDate', value: '2027-01-15', confidence: 'high' }),
    );
    expect(result.fields).toContainEqual(
      expect.objectContaining({ field: 'policyNumber', value: 'ABC-12345' }),
    );
  });

  it('normalises DD/MM/YYYY dates', () => {
    expect(normalizeDate('15/01/2027')).toBe('2027-01-15');
    expect(normalizeDate('2027-01-15')).toBe('2027-01-15');
    expect(normalizeDate('99/99/9999')).toBeNull(); // invalid calendar date
  });

  it('returns no suggestions when nothing matches (never guesses)', () => {
    const result = extractDocumentFields('Just a friendly letter with no dates at all.');
    expect(result.suggestedExpiry).toBeUndefined();
    expect(result.fields).toEqual([]);
  });

  it('extractTextForIntelligence refuses binary buffers', () => {
    expect(extractTextForIntelligence(Buffer.from([0x89, 0x50, 0x00]), 'image/png')).toBeNull();
    expect(
      extractTextForIntelligence(Buffer.from('expiry date: 2027-01-01'), 'text/plain'),
    ).toContain('expiry date');
  });
});

describe('NoopMalwareScanner', () => {
  it('reports clean without inspecting', async () => {
    const scanner = new NoopMalwareScanner();
    await expect(scanner.scan(Buffer.from('anything'), 'f.exe')).resolves.toEqual({
      clean: true,
      threats: [],
      scanner: 'noop',
    });
  });
});
