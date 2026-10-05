import { renderPdf } from './pdf';
import { toXlsx } from './xlsx';

describe('pdf', () => {
  it('renders a valid PDF document', () => {
    const buf = renderPdf({
      title: 'Payslip',
      subtitle: 'September 2026',
      sections: [
        {
          heading: 'Employee',
          keyValues: [
            { label: 'Name', value: 'Ada Lovelace' },
            { label: 'Net pay', value: '£4,500.00' },
          ],
          table: {
            headers: ['Component', 'Type', 'Amount'],
            rows: [
              ['Base Salary', 'EARNING', '5000.00'],
              ['Tax (20% of gross)', 'DEDUCTION', '500.00'],
            ],
          },
          notes: ['This is a computer-generated payslip.'],
        },
      ],
      footer: 'NEO EMS',
    });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = buf.toString('utf8');
    expect(text).toContain('%%EOF');
    expect(text).toContain('Ada Lovelace');
    // Escaped parentheses must not corrupt the stream.
    const tricky = renderPdf({
      title: 'Tricky (name) \\ test',
      sections: [],
    });
    expect(tricky.toString('utf8')).toContain('Tricky \\(name\\) \\\\ test');
  });

  it('paginates long tables instead of dropping rows', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`row-${i}`, 'x', `${i}`]);
    const buf = renderPdf({
      title: 'Long report',
      sections: [{ table: { headers: ['A', 'B', 'C'], rows } }],
    });
    const text = buf.toString('utf8');
    const pageCount = (text.match(/\/Type \/Page[^s]/g) || []).length;
    expect(pageCount).toBeGreaterThan(1);
  });
});

describe('xlsx', () => {
  it('builds a zip archive with the expected parts', () => {
    const buf = toXlsx(['Name', 'Amount'], [['Ada', 4500], ['Bo', 'n/a']]);
    // ZIP local file header signature.
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    // End of central directory signature present.
    expect(buf.toString('binary')).toContain('xl/worksheets/sheet1.xml');
    const text = buf.toString('utf8');
    expect(text).toContain('Ada');
    expect(text).toContain('<v>4500</v>');
  });

  it('escapes XML special chars in strings', () => {
    const buf = toXlsx(['H'], [['a<b>&"c']]);
    expect(buf.toString('utf8')).toContain('a&lt;b&gt;&amp;&quot;c');
  });
});
