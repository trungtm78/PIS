import { BOQ_RETENTION_RULE, MAX_BOQ_LINES, MAX_ROW_ERRORS, boqLineAmount, boqTotal, linesHash, parseBoqLines, percentText, plainDecimal, reconciliationOf, rowErrorsProblem, totalMismatch } from '../src/ctr-boq-lines';

const line = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  business_key: 'B01',
  description: 'Excavation',
  unit_code: 'M3',
  quantity: '3',
  unit_price: '1234.5',
  ...extra,
});

const faults = (raw: unknown) => {
  const parsed = parseBoqLines(raw);
  return parsed.errors.map((error) => `${error.row}:${error.field}:${error.reason}`);
};

describe('the amount of a BOQ line (BR-CTR-02)', () => {
  it('rounds 3 x 1,234.5 = 3,703.5 to 3,704 half up and up and to 3,703 down (AC-ST-CTR-002-1)', () => {
    expect(boqLineAmount('3', '1234.5', 'HALF_UP')).toBe('3704');
    expect(boqLineAmount('3', '1234.5', 'DOWN')).toBe('3703');
    expect(boqLineAmount('3', '1234.5', 'UP')).toBe('3704');
  });

  it('is exact where a float is not: 0.1 x 0.2 stays a hundredth and a long product keeps every digit', () => {
    expect(boqLineAmount('0.1', '0.2', 'UP')).toBe('1');
    expect(boqLineAmount('0.1', '0.2', 'HALF_UP')).toBe('0');
    expect(boqLineAmount('123456789012.123456', '987654321098.654321', 'DOWN')).toBe('121932631136788598396684');
    expect(boqLineAmount('0.000001', '0.000001', 'UP')).toBe('1');
    expect(boqLineAmount('0.5', '1', 'HALF_UP')).toBe('1');
    expect(boqLineAmount('0.4999999', '1', 'HALF_UP')).toBe('0');
  });

  it('adds amounts exactly and compares a total with the value of the revision', () => {
    expect(boqTotal(['3704', '1', '99999999999999999999'])).toBe('100000000000000003704');
    expect(boqTotal([])).toBe('0');
    expect(reconciliationOf('3704', '3704', 1)).toEqual({ revisionAmountVnd: '3704', linesTotalVnd: '3704', differenceVnd: '0', lineCount: 1, matches: true });
    expect(reconciliationOf('3704', '3703', 1)).toMatchObject({ differenceVnd: '-1', matches: false });
    expect(reconciliationOf('3704', '3705', 2)).toMatchObject({ differenceVnd: '1', matches: false });
    expect(totalMismatch(reconciliationOf('3704', '3703', 1))).toMatchObject({
      code: 'BOQ_TOTAL_MISMATCH',
      status: 422,
      extensions: { lines_total_vnd: '3703', revision_amount_vnd: '3704', difference_vnd: '-1' },
    });
  });

  it('writes a decimal without the zeros that carry nothing, and a percentage with four digits', () => {
    expect(plainDecimal('1234.500000')).toBe('1234.5');
    expect(plainDecimal('3.000000')).toBe('3');
    expect(plainDecimal('30')).toBe('30');
    expect(plainDecimal('0.000100')).toBe('0.0001');
    expect(percentText('5')).toBe('5.0000');
    expect(percentText('7.5')).toBe('7.5000');
  });
});

describe('reading the lines of an import', () => {
  it('reads a line with its defaults: half up, the retention of the labelled rule, no milestone and no member', () => {
    const parsed = parseBoqLines([line()]);
    expect(parsed.errorRows).toBe(0);
    expect(parsed.lines).toEqual([
      {
        businessKey: 'B01',
        description: 'Excavation',
        unitCode: 'M3',
        quantity: '3',
        unitPrice: '1234.5',
        roundingRule: 'HALF_UP',
        retentionPct: BOQ_RETENTION_RULE.defaultPct,
        retentionDefaulted: true,
        milestoneCode: null,
        milestoneDueOn: null,
        partyContractorId: null,
        amountVnd: '3704',
      },
    ]);
    expect(BOQ_RETENTION_RULE).toMatchObject({ key: 'CTR.RETENTION', awaitingConfirmation: true, cxn: 'CXN-EXE-04' });
  });

  it('keeps what the line names: the rule, the retention, the milestone, the date and the member in lower case', () => {
    const parsed = parseBoqLines([
      line({
        rounding_rule: 'DOWN',
        retention_pct: '7.5',
        milestone_code: ' M-1 ',
        milestone_due_on: '2026-12-31',
        party_contractor_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        business_key: ' B01 ',
        quantity: '3.000000',
        unit_price: '1234.500000',
      }),
    ]);
    expect(parsed.lines[0]).toMatchObject({
      businessKey: 'B01',
      roundingRule: 'DOWN',
      amountVnd: '3703',
      retentionPct: '7.5000',
      retentionDefaulted: false,
      milestoneCode: 'M-1',
      milestoneDueOn: '2026-12-31',
      partyContractorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: '3',
      unitPrice: '1234.5',
    });
  });

  it('judges every row and names each fault, so the file is put right once', () => {
    expect(
      faults([
        line({ business_key: 'B01' }),
        line({ business_key: 'B01' }),
        line({ business_key: '', description: 5, unit_code: '-bad', quantity: '1e3', unit_price: '-1' }),
        line({ business_key: 'B04', quantity: '1.1234567', unit_price: `${'9'.repeat(19)}`, rounding_rule: 'CEILING', retention_pct: '101', milestone_due_on: '2026-02-30', party_contractor_id: 'x' }),
        line({ business_key: 'B05', unexpected: 'x', quantity: 3, unit_price: undefined }),
        'not a line',
        null,
        [],
      ]),
    ).toEqual([
      '2:business_key:duplicateKey',
      '3:business_key:required',
      '3:description:invalidText',
      '3:unit_code:invalidText',
      '3:quantity:invalidNumber',
      '3:unit_price:invalidNumber',
      '4:quantity:tooPrecise',
      '4:unit_price:tooLarge',
      '4:rounding_rule:invalidRounding',
      '4:retention_pct:invalidPercent',
      '4:milestone_due_on:invalidDate',
      '4:party_contractor_id:invalidId',
      '5:unexpected:notAllowed',
      '5:quantity:invalidNumber',
      '5:unit_price:required',
      '6:row:notAnObject',
      '7:row:notAnObject',
      '8:row:notAnObject',
    ]);
    expect(parseBoqLines([line(), line({ business_key: '' })])).toMatchObject({ errorRows: 1 });
  });

  it('refuses a text that is too long or holds a control character, and an amount that does not fit 24 digits', () => {
    expect(faults([line({ business_key: 'K'.repeat(101) }), line({ business_key: 'B2', description: 'D'.repeat(2001) }), line({ business_key: 'B3', description: 'tab\there' })])).toEqual([
      '1:business_key:tooLong',
      '2:description:tooLong',
      '3:description:invalidText',
    ]);
    expect(faults([line({ quantity: '999999999999999999', unit_price: '999999999999999999' })])).toEqual(['1:unit_price:amountTooLarge']);
    expect(faults([line({ milestone_code: 'M'.repeat(101) }), line({ business_key: 'B2', milestone_due_on: 20260101 }), line({ business_key: 'B3', retention_pct: 5 })])).toEqual([
      '1:milestone_code:tooLong',
      '2:milestone_due_on:invalidDate',
      '3:retention_pct:invalidPercent',
    ]);
  });

  it('accepts 100 percent and zero, refuses 100.0001 and a negative, and refuses a quantity written with a comma', () => {
    expect(parseBoqLines([line({ retention_pct: '100' }), line({ business_key: 'B2', retention_pct: '0' }), line({ business_key: 'B3', retention_pct: '100.0000' })]).errorRows).toBe(0);
    expect(faults([line({ retention_pct: '100.0001' }), line({ business_key: 'B2', retention_pct: '-1' }), line({ business_key: 'B3', quantity: '1,5' }), line({ business_key: 'B4', quantity: '007' })])).toEqual([
      '1:retention_pct:invalidPercent',
      '2:retention_pct:invalidPercent',
      '3:quantity:invalidNumber',
      '4:quantity:invalidNumber',
    ]);
  });

  it('refuses an empty import and one above the limit as a fault of the lines, not of a row', () => {
    for (const raw of [[], 'lines', undefined, new Array<unknown>(MAX_BOQ_LINES + 1).fill(line())]) {
      expect(() => parseBoqLines(raw)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: 'lines' }));
    }
    expect(parseBoqLines(Array.from({ length: MAX_BOQ_LINES }, (_unused, index) => line({ business_key: `B${index}` }))).lines).toHaveLength(MAX_BOQ_LINES);
  });

  it('keeps the first faults only, with the count of the rows with a fault whole', () => {
    const parsed = parseBoqLines(Array.from({ length: MAX_ROW_ERRORS + 20 }, () => line({ quantity: 'x' })));
    expect(parsed.errors).toHaveLength(MAX_ROW_ERRORS);
    expect(parsed.errorRows).toBe(MAX_ROW_ERRORS + 20);
    expect(rowErrorsProblem(parsed)).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'lines', extensions: { error_rows: MAX_ROW_ERRORS + 20 } });
  });
});

describe('the hash of lines that came without a file', () => {
  it('is the same for the same lines and changes with any figure, but not with the defaulted flag', () => {
    const [first] = parseBoqLines([line()]).lines;
    const [same] = parseBoqLines([line({ quantity: '3.0' })]).lines;
    const [other] = parseBoqLines([line({ quantity: '4' })]).lines;
    if (first === undefined || same === undefined || other === undefined) throw new Error('lines expected');
    expect(linesHash([first])).toBe(linesHash([same]));
    expect(linesHash([first])).not.toBe(linesHash([other]));
    expect(linesHash([first])).toMatch(/^[0-9a-f]{64}$/);
    expect(linesHash([first])).toBe(linesHash([{ ...first, retentionDefaulted: false }]));
  });
});
