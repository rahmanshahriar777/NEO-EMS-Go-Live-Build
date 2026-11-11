import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MediaValidationError,
  createOoxmlMacroScannerTransform,
  detectFieldMediaMime,
  hasExifGpsIfd,
  inspectHeifFtypBrand,
  sanitizeFileName,
  validateUtf8TextBuffer,
} from '../media-validation.js';

function makeFtypBox(majorBrand: string, compatBrands: string[]): Buffer {
  const size = 16 + compatBrands.length * 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 4, 'ascii');
  buf.write(majorBrand.padEnd(4, ' ').slice(0, 4), 8, 4, 'ascii');
  buf.writeUInt32BE(0, 12);
  compatBrands.forEach((b, i) => {
    buf.write(b.padEnd(4, ' ').slice(0, 4), 16 + i * 4, 4, 'ascii');
  });
  return buf;
}

describe('media-validation', () => {
  it('sanitizes filenames against traversal and control bytes', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('..\\..\\evil\x00file .heic'), 'evilfile_.heic');
    assert.equal(sanitizeFileName('...'), 'file');
  });

  it('distinguishes genuine still-image HEIC from spoofed MP4 ftyp brands', async () => {
    const validHeic = makeFtypBox('heic', ['mif1', 'heic']);
    const heicBrand = inspectHeifFtypBrand(validHeic);
    assert.ok(heicBrand?.isValidStillImage);

    const detected = await detectFieldMediaMime(validHeic, 'application/octet-stream');
    assert.equal(detected.mimeType, 'image/heic');
    assert.equal(detected.mediaKind, 'IMAGE');

    const spoofedMp4 = makeFtypBox('mp42', ['mp42', 'isom']);
    const mp4Brand = inspectHeifFtypBrand(spoofedMp4);
    assert.equal(mp4Brand?.isValidStillImage, false);

    await assert.rejects(
      () => detectFieldMediaMime(spoofedMp4, 'image/heic'),
      (err: unknown) => err instanceof MediaValidationError && err.code === 'UNSUPPORTED_MIME_TYPE',
    );
  });

  it('detects PNG, JPEG, PDF magic bytes and rejects SVG/HTML/macros', async () => {
    const pngSig = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const png = await detectFieldMediaMime(pngSig, 'application/octet-stream');
    assert.equal(png.mimeType, 'image/png');
    assert.equal(png.mediaKind, 'IMAGE');

    const pdfSig = Buffer.from('%PDF-1.7\n%EOF\n', 'utf8');
    const pdf = await detectFieldMediaMime(pdfSig, 'image/jpeg');
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.equal(pdf.mediaKind, 'DOCUMENT');

    // Macro scanner catches vbaProject.bin split across stream chunks
    const { transform, hasMacro } = createOoxmlMacroScannerTransform();
    await pipeline(
      Readable.from([Buffer.from('PK\x03\x04word/vbaPro'), Buffer.from('ject.binPK\x05\x06')]),
      transform,
      async (src) => {
        for await (const _ of src) {
          // drain
        }
      },
    );
    assert.equal(hasMacro(), true);

    await assert.rejects(
      () => detectFieldMediaMime(pngSig, 'image/png', undefined, { hasVbaMacro: true }),
      (err: unknown) =>
        err instanceof MediaValidationError && err.code === 'MACRO_ENABLED_OFFICE_FORBIDDEN',
    );
  });

  it('accepts international UTF-8 CSV/TXT and rejects NUL-filled binaries', async () => {
    const utf8Csv = Buffer.from('Site,Inspector,Note\nZurich,Renée,Überprüfung № 42 — OK\n', 'utf8');
    assert.equal(validateUtf8TextBuffer(utf8Csv), true);
    const csv = await detectFieldMediaMime(utf8Csv, 'text/csv');
    assert.equal(csv.mimeType, 'text/csv');
    assert.equal(csv.mediaKind, 'DOCUMENT');

    const binaryWithNul = Buffer.from([0x41, 0x42, 0x00, 0x43]);
    assert.equal(validateUtf8TextBuffer(binaryWithNul), false);
    await assert.rejects(() => detectFieldMediaMime(binaryWithNul, 'text/plain'));
  });

  it('parses TIFF IFD0 GPS pointer tag 0x8825 accurately', () => {
    // Little-endian TIFF with 2 IFD0 entries: 0x0112 (Orientation) and 0x8825 (GPSInfo)
    const withGps = Buffer.alloc(40);
    withGps.write('II', 0, 2, 'ascii');
    withGps.writeUInt16LE(42, 2);
    withGps.writeUInt32LE(8, 4);
    withGps.writeUInt16LE(2, 8);
    withGps.writeUInt16LE(0x0112, 10);
    withGps.writeUInt16LE(0x8825, 22);
    assert.equal(hasExifGpsIfd(withGps), true);

    const withoutGps = Buffer.from(withGps);
    withoutGps.writeUInt16LE(0x010f, 22); // Make instead of GPS
    assert.equal(hasExifGpsIfd(withoutGps), false);
  });
});

