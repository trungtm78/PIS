import { assertReportState, checkedCorrection, decidedMneReport, fitsKind, missingFields, mneReportPayload, mneReportSourceRef, narrativeFaults, parseMneReportSourceRef, parseReportSchema, periodEndOfLabel } from '../src/mne-report.ts';

const schema = parseReportSchema({
  fields: [
    { key: 'plan_total_vnd', label: 'Plan', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
    { key: 'rate_pm_pct', kind: 'PERCENT', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' } },
    { key: 'projects_implementation', kind: 'INTEGER', source: { kind: 'PROJECT_COUNT', stage: 'IMPLEMENTATION' } },
    { key: 'difficulties', label: 'Difficulties', kind: 'TEXT', required: true },
    { key: 'proposals', kind: 'TEXT' },
  ],
});

describe('the monitoring report (ST-MNE-002, MNE F3)', () => {
  it('reads the fields of a form: a key, a kind, whether it is needed, and the source that fills it and locks it', () => {
    expect(schema.fields.map((field) => [field.key, field.kind, field.required, field.source?.kind ?? null])).toEqual([
      ['plan_total_vnd', 'MONEY', true, 'SNAPSHOT_METRIC'],
      ['rate_pm_pct', 'PERCENT', true, 'SNAPSHOT_METRIC'],
      ['projects_implementation', 'INTEGER', false, 'PROJECT_COUNT'],
      ['difficulties', 'TEXT', true, null],
      ['proposals', 'TEXT', false, null],
    ]);
    expect(schema.fields[1]?.label).toBe('rate_pm_pct');
    expect(parseReportSchema({ tables: [], awaiting: 'CXN-10' }).fields).toEqual([]);
    expect(parseReportSchema(null).fields).toEqual([]);
  });

  it('refuses a form that does not make sense: a key twice, a kind that is not one, a source that is not one, a text that has a source', () => {
    const bad = (field: Record<string, unknown>) => () => parseReportSchema({ fields: [field] });
    expect(bad({ key: 'Bad Key', kind: 'TEXT' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'schema_json.fields[0].key' }));
    expect(bad({ key: 'a', kind: 'DATE' })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[0].kind' }));
    expect(bad({ key: 'a', kind: 'MONEY', source: { kind: 'GUESS' } })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[0].source.kind' }));
    expect(bad({ key: 'a', kind: 'MONEY', source: { kind: 'SNAPSHOT_METRIC', metric: 'vibes' } })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[0].source.metric' }));
    expect(bad({ key: 'a', kind: 'TEXT', source: { kind: 'WARNING_COUNT' } })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[0].source' }));
    expect(bad({ key: 'a', kind: 'MONEY', source: { kind: 'APPROPRIATION_TOTAL', plan_year: 1 } })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[0].source.plan_year' }));
    expect(() => parseReportSchema({ fields: [{ key: 'a', kind: 'TEXT' }, { key: 'a', kind: 'TEXT' }] })).toThrow(expect.objectContaining({ detail: 'schema_json.fields[1].key' }));
  });

  it('knows the last day of the period of a label, and only of the labels of a year', () => {
    expect([periodEndOfLabel('H1-2027', 2027), periodEndOfLabel('H2-2027', 2027), periodEndOfLabel('YEAR-2026', 2026)]).toEqual(['2027-06-30', '2027-12-31', '2026-12-31']);
    expect([periodEndOfLabel('H1-2027', 2026), periodEndOfLabel('2026-W41', 2026), periodEndOfLabel('Q1-2027', 2027)]).toEqual([null, null, null]);
  });

  it('tells a narrative that touches a locked cell, and one that names a cell the form does not have', () => {
    expect(narrativeFaults(schema, { difficulties: 'x', proposals: 'y' })).toEqual({ locked: [], unknown: [] });
    expect(narrativeFaults(schema, { plan_total_vnd: '1', rate_pm_pct: '2', nope: 'z', difficulties: 'x' })).toEqual({ locked: ['plan_total_vnd', 'rate_pm_pct'], unknown: ['nope'] });
  });

  it('checks a value against its kind and lists the cells that are needed and empty', () => {
    expect([fitsKind('TEXT', 'abc'), fitsKind('TEXT', 5), fitsKind('INTEGER', 5), fitsKind('INTEGER', '12'), fitsKind('INTEGER', 1.5), fitsKind('MONEY', '1250000000000'), fitsKind('MONEY', 5), fitsKind('PERCENT', '60.0000'), fitsKind('PERCENT', '6x')]).toEqual([
      true, false, true, true, false, true, false, true, false,
    ]);
    expect(missingFields(schema, { plan_total_vnd: '1', rate_pm_pct: null }, { difficulties: '  ' })).toEqual(['rate_pm_pct', 'difficulties']);
    expect(missingFields(schema, { plan_total_vnd: '1', rate_pm_pct: '60.0000' }, { difficulties: 'Flood' })).toEqual([]);
  });

  it('names the state of a report in the refusal of an action that needs another', () => {
    expect(() => assertReportState('ISSUED', ['DRAFT'])).toThrow(expect.objectContaining({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_status: 'ISSUED' } }));
    expect(() => assertReportState('DRAFT', ['DRAFT'])).not.toThrow();
  });
});

describe('review, approval and issue (ST-MNE-003)', () => {
  const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';

  it('approves or returns a report that is in review, and nothing else', () => {
    expect(decidedMneReport('IN_REVIEW', 'approve')).toBe('APPROVED');
    expect(decidedMneReport('IN_REVIEW', 'return')).toBe('DRAFT');
    for (const status of ['DRAFT', 'APPROVED', 'ISSUING', 'ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED'] as const) {
      expect(() => decidedMneReport(status, 'approve')).toThrow(expect.objectContaining({ code: 'REPORT_STATE_INVALID', status: 409 }));
    }
  });

  it('names a report to DOC by its id and revision, and reads that name back only when it is whole', () => {
    expect(mneReportSourceRef(ID.toUpperCase(), 2)).toBe(`MNE:mne_report:${ID}:r2`);
    expect(parseMneReportSourceRef(`MNE:mne_report:${ID}:r2`)).toEqual({ id: ID, revision: 2 });
    for (const bad of [undefined, 42, '', `AUD:mne_report:${ID}:r1`, `MNE:mne_report:${ID}:r0`, `MNE:mne_report:${ID}:r1x`, `MNE:mne_report:${ID.toUpperCase()}:r1`, `MNE:mne_report:not-an-id:r1`]) {
      expect(parseMneReportSourceRef(bad)).toBeUndefined();
    }
  });

  it('prints money with dots, a percent with its sign, a dash for an empty cell, and the same report always gives the same payload', () => {
    const input = {
      title: 'Báo cáo giám sát',
      periodLabel: 'H1-2026',
      unitCode: 'CDT-1',
      unitName: 'Chủ đầu tư 1',
      dueDate: '2026-07-10',
      asOfDate: '2026-06-30',
      cells: [
        { label: 'Kế hoạch', kind: 'MONEY', value: '1250000000000' },
        { label: 'Hoàn trả', kind: 'MONEY', value: '-1500' },
        { label: 'Tỷ lệ', kind: 'PERCENT', value: '48.0000' },
        { label: 'Số dự án', kind: 'INTEGER', value: 4 },
        { label: 'Đánh giá', kind: 'TEXT', value: 'Đạt kế hoạch.' },
        { label: 'Khó khăn', kind: 'TEXT', value: null },
      ],
    } as const;
    const payload = mneReportPayload(input);
    expect((payload.body ?? '').split('\n')).toEqual(['Kế hoạch: 1.250.000.000.000 đồng', 'Hoàn trả: -1.500 đồng', 'Tỷ lệ: 48.0000%', 'Số dự án: 4', 'Đánh giá: Đạt kế hoạch.', 'Khó khăn: -']);
    expect(payload.period).toBe('Kỳ báo cáo H1-2026 - Chủ đầu tư 1 (CDT-1); hạn nộp 2026-07-10; số liệu đến ngày 2026-06-30');
    expect(payload).toMatchObject({ title: 'Báo cáo giám sát', agency: 'Chủ đầu tư 1', place: '-' });
    expect(mneReportPayload(input)).toEqual(payload);
    expect(mneReportPayload({ ...input, asOfDate: null }).period).toBe('Kỳ báo cáo H1-2026 - Chủ đầu tư 1 (CDT-1); hạn nộp 2026-07-10');
  });
});

describe('correction of an issued report (ST-MNE-007)', () => {
  it('asks for a reason of ten characters at least, and returns it trimmed', () => {
    expect(checkedCorrection({ status: 'ISSUED' }, '  The plan figure was wrong.  ')).toBe('The plan figure was wrong.');
    for (const reason of [undefined, null, 42, '', '   ', 'too short']) {
      expect(() => checkedCorrection({ status: 'ISSUED' }, reason)).toThrow(expect.objectContaining({ code: 'CORRECTION_REASON_REQUIRED', status: 422 }));
    }
    expect(() => checkedCorrection({ status: 'ISSUED' }, 'x'.repeat(2001))).toThrow(expect.objectContaining({ code: 'CORRECTION_REASON_REQUIRED' }));
  });

  it('corrects a report that was issued, exported, filed or sent back, and no other', () => {
    for (const status of ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED'] as const) expect(() => checkedCorrection({ status }, 'A reason that is long enough')).not.toThrow();
    for (const status of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'SUPERSEDED'] as const) {
      expect(() => checkedCorrection({ status }, 'A reason that is long enough')).toThrow(expect.objectContaining({ code: 'REPORT_NOT_ISSUED', status: 409 }));
    }
  });
});
