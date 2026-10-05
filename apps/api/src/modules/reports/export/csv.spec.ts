import { escapeCsvField, toCsv } from './csv';

describe('csv', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('builds a well-formed document', () => {
    const out = toCsv(['name', 'amount'], [['Ada', 100], ['Bo, "B"', 200]]);
    expect(out).toBe('name,amount\r\nAda,100\r\n"Bo, ""B""",200\r\n');
  });
});
