import { DomainError } from '../src/errors';
import {
  NARRATIVE_FIELDS,
  NARRATIVE_FIELD_MAX_CHARS,
  NARRATIVE_MANDATORY_FACTS,
  directiveLine,
  directiveRefOf,
  enterpriseNarrativeOf,
  entryRuleOf,
  evaluateEntryRules,
  fieldHash,
  fillNarrative,
  inheritNarrative,
  inheritanceHashes,
  narrativeEntryValues,
  narrativeOf,
  parseNarrativeImport,
  projectNarrativeBlocks,
  unchangedInherited,
  validateRuleParams,
} from '../src/index';
import type { EnterpriseNarrative, NarrativeBlock, ReportFillData } from '../src/index';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const block = (fields: Partial<Record<(typeof NARRATIVE_FIELDS)[number], string>>, more: Partial<EnterpriseNarrative> = {}): EnterpriseNarrative => {
  const made = enterpriseNarrativeOf(fields);
  if (made === null) throw new Error('empty block');
  return { ...made, ...more };
};

describe('the enterprise narrative block', () => {
  it('reads the eight fields, trimmed and normalised, and keeps the ones left out as null', () => {
    const one = block({ status: '  Dang thi cong  ', schedule: 'Cham 2 thang', next_plan: 'Hoan thanh mong' });
    expect(one.fields.status).toBe('Dang thi cong');
    expect(one.fields.disbursement).toBeNull();
    expect(Object.keys(one.fields)).toEqual([...NARRATIVE_FIELDS]);
    expect(one.packVersion).toBe(1);
  });

  it('treats a block with no word, no cause and no directive as none', () => {
    expect(enterpriseNarrativeOf({ status: '   ' })).toBeNull();
    expect(enterpriseNarrativeOf(undefined)).toBeNull();
    expect(enterpriseNarrativeOf({ cause_codes: ['SITE_HANDOVER'] })).not.toBeNull();
  });

  it('refuses a field that is too long, a repeated or malformed cause code and a directive with an unknown state', () => {
    const refusal = (raw: Parameters<typeof enterpriseNarrativeOf>[0]): string | undefined => {
      try {
        enterpriseNarrativeOf(raw);
        return undefined;
      } catch (error) {
        return error instanceof DomainError ? error.detail : 'other';
      }
    };
    expect(refusal({ causes: 'x'.repeat(NARRATIVE_FIELD_MAX_CHARS + 1) })).toBe('narrative.enterprise.causes');
    expect(refusal({ cause_codes: ['A', 'A'] })).toBe('narrative.enterprise.cause_codes[1]');
    expect(refusal({ cause_codes: ['bad code'] })).toBe('narrative.enterprise.cause_codes[0]');
    expect(refusal({ directive_refs: [{ id: UUID_A, code: 'CD-1', status_at_end: 'WHATEVER' }] })).toBe('narrative.enterprise.directive_refs[0].status_at_end');
    expect(refusal({ directive_refs: [{ id: UUID_A, code: 'CD-1', status_at_end: 'DONE' }, { id: UUID_A, code: 'CD-2', status_at_end: 'DONE' }] })).toBe('narrative.enterprise.directive_refs[1].id');
    expect(refusal({ status: 'ok' })).toBeUndefined();
  });

  it('rides inside the narrative of a report and keeps the base sections as they were', () => {
    const made = narrativeOf({ results: 'base words', enterprise: { status: 'enterprise words' } });
    expect(made?.resultsText).toBe('base words');
    expect(made?.enterprise?.fields.status).toBe('enterprise words');
    expect(narrativeOf({ results: 'base words' })?.enterprise).toBeUndefined();
    expect(narrativeOf({ enterprise: { status: '' } })).toBeNull();
  });
});

describe('inheritance from the previous period', () => {
  const previous = block({ status: 'last period status', causes: 'late site handover', proposals: 'ask for support' }, { causeCodes: ['SITE_HANDOVER'] });

  it('fills only the fields the draft left empty and never overwrites what a person wrote', () => {
    const current = block({ status: 'my own words' });
    const { block: merged, copied } = inheritNarrative(previous, current);
    expect(merged.fields.status).toBe('my own words');
    expect(merged.fields.causes).toBe('late site handover');
    expect(copied).toEqual(expect.arrayContaining(['causes', 'proposals']));
    expect(copied).not.toContain('status');
    expect(merged.causeCodes).toEqual(['SITE_HANDOVER']);
  });

  it('does not carry the directives of the previous period', () => {
    const withRefs = block({ status: 'x' }, { directiveRefs: [{ id: UUID_A, code: 'CD-1', statusAtEnd: 'DONE' }] });
    expect(inheritNarrative(withRefs, null).block.directiveRefs).toEqual([]);
  });

  it('keeps the hash of each copied field so words kept as they were can be told from words rewritten', () => {
    const { block: merged, copied } = inheritNarrative(previous, null);
    const hashes = inheritanceHashes(merged, copied);
    expect(hashes.causes).toBe(fieldHash('late site handover'));
    const trace = { fromReportId: UUID_A, fromPeriodId: UUID_B, at: '2026-11-09T00:00:00Z', by: UUID_B, hashes };
    expect(unchangedInherited(merged, trace)).toEqual(expect.arrayContaining(['status', 'causes', 'proposals']));
    const rewritten = { ...merged, fields: { ...merged.fields, causes: 'new reason' } };
    expect(unchangedInherited(rewritten, trace)).not.toContain('causes');
    expect(unchangedInherited(rewritten, undefined)).toEqual([]);
  });

  it('copies nothing from an empty previous block', () => {
    const empty = { ...block({ status: 'x' }), fields: Object.fromEntries(NARRATIVE_FIELDS.map((field) => [field, null])) } as EnterpriseNarrative;
    expect(inheritNarrative(empty, null).copied).toEqual([]);
  });
});

describe('the rules at entry for the narrative surface', () => {
  const mandatory = entryRuleOf({
    type: 'DATA_ENTRY_RULE',
    code: 'NARRATIVE_MANDATORY_FIELDS',
    version: 1,
    ruleId: 'r1',
    params: validateRuleParams('DATA_ENTRY_RULE', { check: 'FIELD_REQUIRED', severity: 'BLOCK', fields: ['MANDATORY_FIELDS'], surfaces: ['PERIOD_NARRATIVE'], message: 'missing' }),
  });

  it('blocks a narrative that lacks the mandatory fields and names them', () => {
    const verdict = evaluateEntryRules([mandatory], { surface: 'PERIOD_NARRATIVE', values: narrativeEntryValues(block({ status: 'a', schedule: 'b' })), mandatory: NARRATIVE_MANDATORY_FACTS });
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]?.fields).toEqual(['NARRATIVE_DISBURSEMENT', 'NARRATIVE_NEXT_PLAN']);
  });

  it('lets a complete narrative through and does not judge another surface', () => {
    const complete = narrativeEntryValues(block({ status: 'a', schedule: 'b', disbursement: 'c', next_plan: 'd' }));
    expect(evaluateEntryRules([mandatory], { surface: 'PERIOD_NARRATIVE', values: complete, mandatory: NARRATIVE_MANDATORY_FACTS }).violations).toEqual([]);
    expect(evaluateEntryRules([mandatory], { surface: 'DIS_REPORT', values: {}, mandatory: NARRATIVE_MANDATORY_FACTS }).skipped).toEqual([{ ruleCode: 'NARRATIVE_MANDATORY_FIELDS', reason: 'OTHER_SURFACE' }]);
  });

  it('can go red: a narrative with no block at all fails every mandatory field', () => {
    const verdict = evaluateEntryRules([mandatory], { surface: 'PERIOD_NARRATIVE', values: narrativeEntryValues(null), mandatory: NARRATIVE_MANDATORY_FACTS });
    expect(verdict.blocking[0]?.fields).toHaveLength(NARRATIVE_MANDATORY_FACTS.length);
  });
});

describe('the roll-up of the leadership directives', () => {
  const item = { id: UUID_A, code: 'CD-12', meetingDate: '2026-10-28', text: 'Speed up the handover of the site.', assigneeUnitName: 'Project team 1', dueOnAtEnd: '2026-11-15', statusAtEnd: 'IN_PROGRESS' as const, lastNote: null };

  it('writes one line with the code, the day of the meeting, the unit, the due day and the state at the end of the period', () => {
    const line = directiveLine(item);
    expect(line).toContain('CD-12');
    expect(line).toContain('2026-10-28');
    expect(line).toContain('Project team 1');
    expect(line).toContain('2026-11-15');
    expect(line).toContain('đang thực hiện');
  });

  it('adds the latest result noted when there is one and keeps a snapshot of the state in the reference', () => {
    expect(directiveLine({ ...item, statusAtEnd: 'DONE', lastNote: 'Handed over on 5 November.' })).toContain('Kết quả: Handed over on 5 November.');
    expect(directiveRefOf(item)).toEqual({ id: UUID_A, code: 'CD-12', statusAtEnd: 'IN_PROGRESS' });
  });
});

describe('the Excel template', () => {
  const table = (headers: string[], rows: string[][]) => ({ format: 'XLSX' as const, headers, rows, lines: rows.map((_row, index) => index + 2) });
  const headers = ['project_code', 'status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals', 'cause_codes'];

  it('reads a row into a block and splits the cause codes on a semicolon, a comma or a line break', () => {
    const parsed = parseNarrativeImport(table(headers, [['PRJ-1', 'a', 'b', 'c', 'd', '', '', 'e', '', 'SITE_HANDOVER; FUNDS,\nDESIGN']]));
    expect(parsed.faults).toEqual([]);
    expect(parsed.rows[0]?.block.causeCodes).toEqual(['SITE_HANDOVER', 'FUNDS', 'DESIGN']);
    expect(parsed.rows[0]?.block.fields.difficulties).toBeNull();
  });

  it('names every fault with its line and column and applies none of the rows with a fault', () => {
    const parsed = parseNarrativeImport(
      table(headers, [
        ['PRJ-1', 'a', '', '', '', '', '', '', '', ''],
        ['PRJ-1', 'b', '', '', '', '', '', '', '', ''],
        ['', 'c', '', '', '', '', '', '', '', ''],
        ['PRJ-2', 'x'.repeat(NARRATIVE_FIELD_MAX_CHARS + 1), '', '', '', '', '', '', '', ''],
        ['PRJ-3', '', '', '', '', '', '', '', '', 'bad code!'],
        ['PRJ-4', '', '', '', '', '', '', '', '', ''],
        ['PRJ-5', 'fine', '', '', '', '', '', '', '', ''],
      ]),
    );
    expect(parsed.totalRows).toBe(7);
    expect(parsed.rows.map((row) => row.projectCode)).toEqual(['PRJ-5']);
    const codes = parsed.faults.map((fault) => `${fault.line}:${fault.field}:${fault.code}`);
    expect(codes).toEqual(expect.arrayContaining(['2:project_code:PROJECT_DUPLICATE_IN_FILE', '3:project_code:PROJECT_DUPLICATE_IN_FILE', '4:project_code:PROJECT_CODE_REQUIRED', '5:status:FIELD_TOO_LONG', '6:cause_codes:CAUSE_CODE_INVALID', '7:row:ROW_EMPTY']));
  });

  it('refuses a file without the column of the project', () => {
    expect(() => parseNarrativeImport(table(['status'], [['a']]))).toThrow(DomainError);
  });
});

describe('the Word document', () => {
  const data = (narratives?: ReportFillData['narratives']): ReportFillData => ({
    period: { kind: 'MONTH', year: 2026, index: 10 },
    meta: {},
    definitions: {},
    figures: [],
    datasets: {},
    narratives,
  });
  const skeleton: NarrativeBlock[] = [
    { type: 'HEADING', level: 2, text: 'Section' },
    { type: 'PARAGRAPH', text: '{{narrative:PROJECTS}}' },
  ];
  const texts = (blocks: readonly NarrativeBlock[]): string[] => blocks.flatMap((one) => (one.type === 'PARAGRAPH' || one.type === 'HEADING' ? [one.text] : one.type === 'LIST' ? one.items : []));

  it('lays out the eight headed fields for each project and keeps a bracketed hint for a field nobody wrote', () => {
    const filled = fillNarrative(skeleton, data([{ projectCode: 'PRJ-1', projectName: 'Plant', fields: { status: 'Line one\nLine two', schedule: 'Late' }, causeLabels: ['Site handover'], directiveLines: ['CD-1 line'] }]), 'BILLION_VND');
    const lines = texts(filled.blocks);
    expect(lines).toEqual(expect.arrayContaining(['PRJ-1 - Plant', 'Line one', 'Line two', 'Late', 'CD-1 line']));
    expect(lines.filter((line) => line.startsWith('['))).toHaveLength(6);
    expect(filled.issues).toEqual([]);
    expect(lines.some((line) => line.includes('Site handover'))).toBe(true);
  });

  it('says there is no narrative when there is none, and never writes words of its own for a field', () => {
    expect(texts(fillNarrative(skeleton, data(undefined), 'BILLION_VND').blocks)[1]).toMatch(/^\[.+\]$/);
    expect(projectNarrativeBlocks([])).toHaveLength(1);
  });
});
