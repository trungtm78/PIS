import { DomainError, fileSha256, planFileImport } from '@machvon/kernel';
import {
  DEFAULT_TREASURY_COLUMNS,
  checkTreasuryLayout,
  TREASURY_CONNECTOR_CODE,
  TREASURY_FILE_PROVIDER,
  TREASURY_FORMAT_VERSION,
  createTreasuryStatementFormat,
  normalizeHeader,
  statementDate,
  statementInstant,
  treasuryBusinessKey,
  wholeVnd,
} from '../src/pay-treasury-statement-format';

const HEADER = 'document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at,payee_account';
const csv = (...lines: string[]): Uint8Array => Buffer.from([HEADER, ...lines].join('\n'), 'utf8');
const format = createTreasuryStatementFormat();
const plan = (...lines: string[]) => planFileImport(format, csv(...lines));

describe('the Treasury statement layout (a working assumption, ST-PAY-006)', () => {
  it('says what it is: the connector of ST-MDM-007 and a layout version that marks the layout as assumed', () => {
    expect(format.connectorCode).toBe(TREASURY_CONNECTOR_CODE);
    expect(format.connectorCode).toBe('TREASURY_STATEMENT_FILE');
    expect(format.formatVersion).toBe(TREASURY_FORMAT_VERSION);
    expect(TREASURY_FORMAT_VERSION).toMatch(/^ASSUMED-/);
  });

  describe('headers', () => {
    it('compares a header without accents, case or punctuation', () => {
      expect(normalizeHeader('Số chứng từ')).toBe('so_chung_tu');
      expect(normalizeHeader('  Ngày Hạch Toán ')).toBe('ngay_hach_toan');
      expect(normalizeHeader('Đơn-vị (KBNN)')).toBe('don_vi_kbnn');
    });

    it('reads a file whose headers are the Vietnamese ones of the default column map', () => {
      const bytes = Buffer.from('Số chứng từ;Ngày chứng từ;Mã dự án;Mã KBNN;Số tiền;Ngày hạch toán\nCT-1;15/10/2026;PRJ-1;KB-1;1.250.000;2026-10-16\n', 'utf8');
      const [row] = planFileImport(format, bytes).rows;
      expect(row).toMatchObject({ accepted: true, row: { businessKey: 'KBNN_FILE|CT-1|2026-10-15|PRJ-1', measure: '1250000' } });
    });

    it('reads a file in another layout when the column map names its headers', () => {
      const custom = createTreasuryStatementFormat({ columns: { document_no: ['voucher'], amount_vnd: ['paid'] } });
      const bytes = Buffer.from('voucher,document_date,project_code,treasury_office_code,paid,confirmed_at\nV-9,2026-10-15,PRJ-1,KB-1,500,2026-10-16\n', 'utf8');
      expect(planFileImport(custom, bytes).rows[0]).toMatchObject({ accepted: true, row: { businessKey: 'KBNN_FILE|V-9|2026-10-15|PRJ-1', measure: '500' } });
      // The default names no longer apply to the column that the map renamed.
      expect(() => planFileImport(custom, csv('CT-1,2026-10-15,PRJ-1,KB-1,1000,2026-10-16,'))).toThrow(DomainError);
    });

    it.each([
      ['a required column is missing', 'document_no,document_date,project_code,amount_vnd,confirmed_at\nCT-1,2026-10-15,PRJ-1,1000,2026-10-16\n'],
      ['two columns both mean one field', `${HEADER},so_chung_tu\nCT-1,2026-10-15,PRJ-1,KB-1,1000,2026-10-16,,CT-2\n`],
      ['the file is not a table at all', '\u0000\u0001\u0002'],
    ])('refuses the whole file as IMPORT_SCHEMA_INVALID when %s', (_name, content) => {
      let thrown: unknown;
      try {
        planFileImport(format, Buffer.from(content, 'utf8'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect(thrown).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
    });

    it('refuses a file with a header and no row as IMPORT_EMPTY', () => {
      expect(() => planFileImport(format, Buffer.from(`${HEADER}\n`, 'utf8'))).toThrow(expect.objectContaining({ code: 'IMPORT_EMPTY' }));
    });
  });

  describe('a row', () => {
    it('is accepted with a business key made of the provider, the voucher, its date and the project, and the amount as its measure', () => {
      const { rows } = plan('CT-001,2026-10-15,PRJ-A,KB-1,"75,000,000",2026-10-16T09:30:00+07:00,0123456789');
      expect(rows[0]).toMatchObject({
        accepted: true,
        row: {
          businessKey: treasuryBusinessKey(TREASURY_FILE_PROVIDER, 'CT-001', '2026-10-15', 'PRJ-A'),
          measure: '75000000',
          fields: { document_no: 'CT-001', document_date: '2026-10-15', project_code: 'PRJ-A', treasury_office_code: 'KB-1', amount_vnd: '75000000', confirmed_at: '2026-10-16T02:30:00.000Z', direction: 'PAYMENT' },
          record: { documentNo: 'CT-001', projectCode: 'PRJ-A', officeCode: 'KB-1', amountVnd: '75000000', direction: 'PAYMENT' },
        },
      });
    });

    it('has the same hash whatever the spacing, the date format or the grouping of the amount, and another hash for another amount', () => {
      const hashes = plan(
        'CT-1,2026-10-15,PRJ-A,KB-1,75000000,2026-10-16,',
        ' CT-2 ,15/10/2026,PRJ-A,KB-1,"75.000.000",16/10/2026,',
        'CT-3,2026-10-15,PRJ-A,KB-1,75000001,2026-10-16,',
      ).rows.map((row) => row.rowHash);
      const again = plan('CT-1,2026-10-15,PRJ-A,KB-1,75 000 000,2026-10-16T00:00:00+07:00,').rows[0]?.rowHash;
      expect(hashes[0]).toBe(again);
      expect(hashes[1]).not.toBe(hashes[0]);
      expect(hashes[2]).not.toBe(hashes[0]);
    });

    it.each([
      ['a missing voucher number', ',2026-10-15,PRJ-A,KB-1,1000,2026-10-16,', 'DOCUMENT_NO_INVALID', 'document_no', null],
      ['a voucher number with the key separator', 'CT|1,2026-10-15,PRJ-A,KB-1,1000,2026-10-16,', 'DOCUMENT_NO_INVALID', 'document_no', null],
      ['a voucher date that does not exist', 'CT-1,2026-02-30,PRJ-A,KB-1,1000,2026-10-16,', 'DOCUMENT_DATE_INVALID', 'document_date', null],
      ['a missing project code', 'CT-1,2026-10-15,,KB-1,1000,2026-10-16,', 'PROJECT_CODE_INVALID', 'project_code', null],
      ['a missing Treasury office code', 'CT-1,2026-10-15,PRJ-A,,1000,2026-10-16,', 'OFFICE_CODE_INVALID', 'treasury_office_code', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
      ['an amount with a fraction', 'CT-1,2026-10-15,PRJ-A,KB-1,"1000,50",2026-10-16,', 'AMOUNT_INVALID', 'amount_vnd', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
      ['an amount of zero', 'CT-1,2026-10-15,PRJ-A,KB-1,0,2026-10-16,', 'AMOUNT_INVALID', 'amount_vnd', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
      ['a negative amount', 'CT-1,2026-10-15,PRJ-A,KB-1,-5,2026-10-16,', 'AMOUNT_INVALID', 'amount_vnd', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
      ['an amount wider than the column', `CT-1,2026-10-15,PRJ-A,KB-1,${'9'.repeat(25)},2026-10-16,`, 'AMOUNT_INVALID', 'amount_vnd', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
      ['a booking time that does not read', 'CT-1,2026-10-15,PRJ-A,KB-1,1000,yesterday,', 'CONFIRMED_AT_INVALID', 'confirmed_at', 'KBNN_FILE|CT-1|2026-10-15|PRJ-A'],
    ])('is refused for %s, with the code, the field and the key when it has one', (_name, line, code, field, key) => {
      const [row] = plan(line).rows;
      expect(row).toMatchObject({ accepted: false, rejection: { code, field }, businessKey: key });
    });

    it('refuses a refund (it names the payment it undoes) and an unknown direction, and accepts an explicit payment', () => {
      const withDirection = createTreasuryStatementFormat({ columns: { direction: ['direction'] } });
      const run = (direction: string) =>
        planFileImport(withDirection, Buffer.from(`${HEADER},direction\nCT-1,2026-10-15,PRJ-A,KB-1,1000,2026-10-16,,${direction}\n`, 'utf8')).rows[0];
      expect(run('REFUND')).toMatchObject({ accepted: false, rejection: { code: 'REFUND_UNSUPPORTED', field: 'direction' } });
      expect(run('sideways')).toMatchObject({ accepted: false, rejection: { code: 'DIRECTION_INVALID', field: 'direction' } });
      expect(run('payment')).toMatchObject({ accepted: true });
    });

    it('keeps what a person may read of a refused row and hides the account number', () => {
      const [row] = plan('CT-1,2026-10-15,PRJ-A,KB-1,not-a-number,2026-10-16,0123456789').rows;
      expect(row).toMatchObject({ accepted: false });
      const preview = row?.accepted === false ? row.preview : null;
      expect(preview).toMatchObject({ document_no: 'CT-1', amount_vnd: 'not-a-number', payee_account: '***789' });
      expect(JSON.stringify(preview)).not.toContain('0123456789');
    });

    it('shows no account at all when the file has none', () => {
      const bytes = Buffer.from('document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at\nCT-1,2026-10-15,PRJ-A,KB-1,oops,2026-10-16\n', 'utf8');
      const [row] = planFileImport(format, bytes).rows;
      expect(row?.accepted === false ? row.preview : null).not.toHaveProperty('payee_account');
    });

    it('gives the line of the file (the first line is the header), also after blank lines', () => {
      const { rows } = plan('CT-1,2026-10-15,PRJ-A,KB-1,1000,2026-10-16,', '', 'CT-2,2026-10-15,PRJ-A,KB-1,1000,2026-10-16,');
      expect(rows.map((row) => row.line)).toEqual([2, 4]);
    });
  });

  describe('values', () => {
    it('reads whole VND exactly: plain digits or groups of three, never a fraction, a sign, a zero or a figure wider than the column', () => {
      expect(wholeVnd('1250000')).toBe('1250000');
      expect(wholeVnd('1.250.000')).toBe('1250000');
      expect(wholeVnd('1,250,000')).toBe('1250000');
      expect(wholeVnd('1 250 000')).toBe('1250000');
      expect(wholeVnd('1 250 000')).toBe('1250000');
      expect(wholeVnd('9'.repeat(24))).toBe('9'.repeat(24));
      for (const bad of ['', undefined, '0', '007', '-5', '1.5', '1.2500', '1,25', '12a', '1e3', '9'.repeat(25)]) expect(wholeVnd(bad)).toBeUndefined();
    });

    it('reads a date as YYYY-MM-DD or DD/MM/YYYY and nothing else', () => {
      expect(statementDate('2026-10-15')).toBe('2026-10-15');
      expect(statementDate('15/10/2026')).toBe('2026-10-15');
      expect(statementDate('2024-02-29')).toBe('2024-02-29');
      for (const bad of ['', undefined, '2026-13-01', '2026-02-29', '31/04/2026', '15-10-2026', '2026-10-15T00:00:00Z']) expect(statementDate(bad)).toBeUndefined();
    });

    it('reads the booking time as a UTC instant: a date is the start of that day in Vietnam, a time without an offset is Vietnam time', () => {
      expect(statementInstant('2026-10-16')).toBe('2026-10-15T17:00:00.000Z');
      expect(statementInstant('16/10/2026')).toBe('2026-10-15T17:00:00.000Z');
      expect(statementInstant('2026-10-16 08:15')).toBe('2026-10-16T01:15:00.000Z');
      expect(statementInstant('2026-10-16T08:15:30.5')).toBe('2026-10-16T01:15:30.500Z');
      expect(statementInstant('2026-10-16T08:15:30Z')).toBe('2026-10-16T08:15:30.000Z');
      expect(statementInstant('2026-10-16T08:15:30-05:00')).toBe('2026-10-16T13:15:30.000Z');
      for (const bad of ['', undefined, 'soon', '2026-02-30T10:00:00Z', '2026-10-16T25:00:00Z', '2026-10-16T10']) expect(statementInstant(bad)).toBeUndefined();
    });

    it('builds the business key the same way for every source', () => {
      expect(treasuryBusinessKey('KBNN_FILE', 'CT-1', '2026-10-15', 'PRJ-A')).toBe('KBNN_FILE|CT-1|2026-10-15|PRJ-A');
    });
  });

  it('tells before the import which required columns a file lacks, and that two columns for one field are not a layout', () => {
    expect(checkTreasuryLayout(HEADER.split(','))).toEqual({ ok: true, missing: [] });
    expect(checkTreasuryLayout(['Số chứng từ', 'Ngày chứng từ', 'Mã dự án', 'Mã KBNN', 'Số tiền', 'Ngày hạch toán'])).toEqual({ ok: true, missing: [] });
    expect(checkTreasuryLayout(['document_no', 'amount_vnd', 'payee_account'])).toEqual({ ok: false, missing: ['document_date', 'project_code', 'treasury_office_code', 'confirmed_at'] });
    expect(checkTreasuryLayout([...HEADER.split(','), 'so_chung_tu'])).toEqual({ ok: false, missing: [] });
    expect(checkTreasuryLayout(['voucher', ...HEADER.split(',').slice(1)], { columns: { document_no: ['voucher'] } })).toEqual({ ok: true, missing: [] });
    expect(checkTreasuryLayout([])).toMatchObject({ ok: false });
  });

  it('has a default map that names a header for every field', () => {
    for (const headers of Object.values(DEFAULT_TREASURY_COLUMNS)) expect(headers.length).toBeGreaterThan(0);
  });

  it('judges the same file the same way every time, whatever the order of its rows (the identity of the file is its bytes)', () => {
    const first = csv('CT-1,2026-10-15,PRJ-A,KB-1,1000,2026-10-16,', 'CT-2,2026-10-15,PRJ-A,KB-1,2000,2026-10-16,');
    expect(fileSha256(first)).toBe(planFileImport(format, first).fileSha256);
    expect(planFileImport(format, first).rows.map((row) => (row.accepted ? row.row.businessKey : null))).toEqual([
      'KBNN_FILE|CT-1|2026-10-15|PRJ-A',
      'KBNN_FILE|CT-2|2026-10-15|PRJ-A',
    ]);
  });
});
