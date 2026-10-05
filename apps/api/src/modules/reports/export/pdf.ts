/**
 * Minimal PDF writer — dependency-free.
 *
 * Produces valid single/multi-page PDF 1.4 documents using only the built-in
 * Helvetica family (no font embedding). Text is WinAnsi-encoded; characters
 * outside Latin-1 are replaced with `?` rather than emitting corrupt bytes.
 *
 * Good enough for payslips and tabular reports. If pixel-perfect branding,
 * images, or complex layouts are ever needed, prefer adding `pdfkit`.
 */

const PAGE_WIDTH = 595; // A4, points
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface PdfKeyValue {
  label: string;
  value: string;
}

export interface PdfTable {
  headers: string[];
  rows: string[][];
}

export interface PdfSection {
  heading?: string;
  keyValues?: PdfKeyValue[];
  table?: PdfTable;
  notes?: string[];
}

export interface PdfDocumentOptions {
  title: string;
  subtitle?: string;
  generatedAt?: string;
  sections: PdfSection[];
  footer?: string;
}

/** WinAnsi-safe: Helvetica cannot render beyond Latin-1. */
function sanitize(text: string): string {
  return String(text ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) > 255 ? '?' : ch))
    .join('');
}

function escapePdfText(text: string): string {
  return sanitize(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

class PageBuilder {
  private ops: string[] = [];
  y: number = PAGE_HEIGHT - MARGIN;

  get remaining(): number {
    return this.y - MARGIN;
  }

  private ensureSpace(needed: number): boolean {
    return this.remaining >= needed;
  }

  text(x: number, text: string, size: number): void {
    this.ops.push(
      `BT /F1 ${size} Tf ${x.toFixed(1)} ${this.y.toFixed(1)} Td (${escapePdfText(text)}) Tj ET`,
    );
    this.y -= size * 1.35;
  }

  /** Returns false when the block does not fit and the caller must page-break. */
  block(lines: Array<{ text: string; size: number; x?: number }>, gap = 4): boolean {
    const needed = lines.reduce((sum, l) => sum + l.size * 1.35, 0) + gap;
    if (!this.ensureSpace(needed)) return false;
    for (const l of lines) this.text(l.x ?? MARGIN, l.text, l.size);
    this.y -= gap;
    return true;
  }

  /** Filled rectangle (used for table header background). */
  rect(x: number, w: number, h: number, gray: number): void {
    const y0 = this.y - h;
    this.ops.push(
      `${gray.toFixed(2)} g ${x.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 g`,
    );
  }

  table(table: PdfTable): boolean {
    const cols = table.headers.length;
    if (cols === 0) return true;
    const colW = CONTENT_WIDTH / cols;
    const rowH = 15;
    const headerH = 17;
    const needed = headerH + table.rows.length * rowH + 8;
    if (!this.ensureSpace(needed)) return false;

    // Header background + labels.
    this.rect(MARGIN, CONTENT_WIDTH, headerH, 0.88);
    const headerY = this.y - 12.5;
    table.headers.forEach((h, i) => {
      this.ops.push(
        `BT /F1 9 Tf ${(MARGIN + i * colW + 4).toFixed(1)} ${headerY.toFixed(1)} Td (${escapePdfText(h)}) Tj ET`,
      );
    });
    this.y -= headerH;

    for (const row of table.rows) {
      const rowY = this.y - 11.5;
      row.forEach((cell, i) => {
        // Truncate to fit the column rather than overflowing into the next.
        const maxChars = Math.max(4, Math.floor(colW / 5.4));
        const clipped = cell.length > maxChars ? cell.slice(0, maxChars - 1) + '…' : cell;
        this.ops.push(
          `BT /F1 8.5 Tf ${(MARGIN + i * colW + 4).toFixed(1)} ${rowY.toFixed(1)} Td (${escapePdfText(clipped)}) Tj ET`,
        );
      });
      // Row separator.
      this.ops.push(
        `0.8 g ${MARGIN.toFixed(1)} ${(this.y - rowH).toFixed(1)} ${CONTENT_WIDTH.toFixed(1)} 0.5 re f 0 g`,
      );
      this.y -= rowH;
    }
    this.y -= 8;
    return true;
  }

  build(): string {
    return this.ops.join('\n');
  }
}

export function renderPdf(options: PdfDocumentOptions): Buffer {
  const pages: string[] = [];
  let page = new PageBuilder();

  const newPage = () => {
    pages.push(page.build());
    page = new PageBuilder();
  };

  // Title block.
  page.block([
    { text: options.title, size: 17 },
    ...(options.subtitle ? [{ text: options.subtitle, size: 10 }] : []),
    { text: `Generated ${options.generatedAt ?? new Date().toISOString()}`, size: 8 },
  ]);

  for (const section of options.sections) {
    if (section.heading) {
      if (!page.block([{ text: section.heading, size: 12 }])) {
        newPage();
        page.block([{ text: section.heading, size: 12 }]);
      }
    }
    if (section.keyValues) {
      const lines = section.keyValues.map(({ label, value }) => ({
        text: `${label}: ${value}`,
        size: 9.5,
      }));
      if (!page.block(lines)) {
        newPage();
        page.block(lines);
      }
    }
    if (section.table) {
      if (!page.table(section.table)) {
        newPage();
        // Table that still does not fit a fresh page is rendered anyway
        // (truncated by page bottom) rather than dropped silently.
        page.table(section.table);
      }
    }
    if (section.notes) {
      const lines = section.notes.map((n) => ({ text: n, size: 8.5 }));
      if (!page.block(lines)) {
        newPage();
        page.block(lines);
      }
    }
  }

  if (options.footer) {
    page.block([{ text: options.footer, size: 8 }]);
  }
  pages.push(page.build());

  // --- Assemble PDF objects; offsets computed programmatically. ---
  const objects: string[] = [];
  // 1: catalog, 2: pages, then per page: page + content, then font.
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  let nextObj = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(nextObj++);
    contentObjNums.push(nextObj++);
  }
  const fontObj = nextObj++;

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj`;

  pages.forEach((content, i) => {
    const stream = content + '\n';
    objects[pageObjNums[i]] =
      `${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> ` +
      `/Contents ${contentObjNums[i]} 0 R >>\nendobj`;
    objects[contentObjNums[i]] =
      `${contentObjNums[i]} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream\nendobj`;
  });
  objects[fontObj] = `${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`;

  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  let body = header;
  const offsets: number[] = [0];
  for (let n = 1; n < nextObj; n++) {
    offsets[n] = Buffer.byteLength(body, 'utf8');
    body += objects[n] + '\n';
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${nextObj}\n`;
  body += '0000000000 65535 f \n';
  for (let n = 1; n < nextObj; n++) {
    body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${nextObj} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(body, 'utf8');
}
