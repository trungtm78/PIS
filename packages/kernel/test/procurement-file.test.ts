import { DomainError } from '../src/errors';
import { planFileImport } from '../src/file-import';
import {
  MILESTONE_KINDS,
  PROCUREMENT_ADAPTER_STATUS,
  PROCUREMENT_CONNECTOR,
  PROCUREMENT_FORMAT_VERSION,
  milestoneOrderIssue,
  momentOf,
  procurementFileFormat,
  vietnamDayOf,
} from '../src/procurement-file';

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const HEADER = 'package_code,external_code,milestone_kind,actual_at';

function refusal(work: () => unknown): { code: string; status: number; detail?: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected a DomainError');
}

const outcome = (plan: ReturnType<typeof planFileImport>) => plan.rows.map((row) => [row.line, row.accepted ? row.row.businessKey : row.rejection.code]);

describe('the file of the national bidding system (ST-BID-005, working assumption of the layout)', () => {
  it('names the connector, a layout version that says it is an assumption, and the adapter status PROPOSED', () => {
    expect(procurementFileFormat.connectorCode).toBe(PROCUREMENT_CONNECTOR);
    expect(PROCUREMENT_CONNECTOR).toBe('PROCUREMENT_FILE');
    expect(procurementFileFormat.formatVersion).toBe(PROCUREMENT_FORMAT_VERSION);
    expect(PROCUREMENT_FORMAT_VERSION).toContain('ASSUMPTION');
    expect(PROCUREMENT_ADAPTER_STATUS).toBe('PROPOSED');
  });

  it('reads a row into the package, the code on the national network, the kind and the moment, and keys it by package and kind (AC-ST-BID-005-1)', () => {
    const plan = planFileImport(procurementFileFormat, csv(HEADER, 'GT-01,TBMT-001,bid_opening,2026-08-31', 'GT-02,TBMT-002,RESULT_PUBLISHED,31/08/2026'));
    expect(outcome(plan)).toEqual([
      [2, '|GT-01|BID_OPENING'],
      [3, '|GT-02|RESULT_PUBLISHED'],
    ]);
    expect(plan.rows[0]?.accepted && plan.rows[0].row.record).toEqual({ packageCode: 'GT-01', projectCode: null, externalCode: 'TBMT-001', milestoneKind: 'BID_OPENING', actualAt: '2026-08-30T17:00:00.000Z' });
    expect(plan.rows[1]?.accepted && plan.rows[1].row.record.actualAt).toBe('2026-08-30T17:00:00.000Z');
  });

  it('reads the optional project column into the key, the headers without regard to case and space, and ignores other columns', () => {
    const plan = planFileImport(procurementFileFormat, csv(' Package_Code ; PROJECT_CODE ;External_Code;Milestone_Kind;Actual_At;Ghi chu', 'GT-01; DA-001 ;TBMT-001;BID_CLOSING;2026-08-31T09:30:00+07:00;ghi chú'));
    expect(outcome(plan)).toEqual([[2, 'DA-001|GT-01|BID_CLOSING']]);
    expect(plan.rows[0]?.accepted && plan.rows[0].row.record).toMatchObject({ projectCode: 'DA-001', actualAt: '2026-08-31T02:30:00.000Z' });
  });

  it('refuses a file that lacks one of the four columns as IMPORT_SCHEMA_INVALID, and one with no row as IMPORT_EMPTY', () => {
    for (const header of ['external_code,milestone_kind,actual_at', 'package_code,milestone_kind,actual_at', 'package_code,external_code,actual_at', 'package_code,external_code,milestone_kind']) {
      expect(refusal(() => planFileImport(procurementFileFormat, csv(header, 'a,b,c')))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'file' });
    }
    expect(refusal(() => planFileImport(procurementFileFormat, csv(HEADER)))).toMatchObject({ code: 'IMPORT_EMPTY' });
  });

  it('refuses a row with its line, field and a stable code, and shows the cells of the row beside the error', () => {
    const plan = planFileImport(
      procurementFileFormat,
      csv(HEADER, ',TBMT-1,BID_OPENING,2026-08-31', `${'G'.repeat(51)},TBMT-1,BID_OPENING,2026-08-31`, 'GT-01,,BID_OPENING,2026-08-31', `GT-01,${'T'.repeat(101)},BID_OPENING,2026-08-31`, 'GT-01,TBMT-1,SIGNING,2026-08-31', 'GT-01,TBMT-1,BID_OPENING,', 'GT-01,TBMT-1,BID_OPENING,2026-02-30', 'GT-01,TBMT-1,BID_OPENING,2026-08-31T10:00'),
    );
    expect(outcome(plan)).toEqual([
      [2, 'PACKAGE_CODE_EMPTY'],
      [3, 'CODE_INVALID'],
      [4, 'EXTERNAL_CODE_EMPTY'],
      [5, 'CODE_INVALID'],
      [6, 'MILESTONE_KIND_INVALID'],
      [7, 'ACTUAL_AT_INVALID'],
      [8, 'ACTUAL_AT_INVALID'],
      [9, 'ACTUAL_AT_INVALID'],
    ]);
    const fields = plan.rows.map((row) => (row.accepted ? '' : row.rejection.field));
    expect(fields).toEqual(['package_code', 'package_code', 'external_code', 'external_code', 'milestone_kind', 'actual_at', 'actual_at', 'actual_at']);
    const sixth = plan.rows[4];
    expect(sixth?.accepted === false && sixth.preview).toEqual({ project_code: '', package_code: 'GT-01', external_code: 'TBMT-1', milestone_kind: 'SIGNING', actual_at: '2026-08-31' });
  });

  it('refuses a control character in a code', () => {
    const plan = planFileImport(procurementFileFormat, csv(HEADER, 'GT\u0007-01,TBMT-1,BID_OPENING,2026-08-31'));
    expect(outcome(plan)).toEqual([[2, 'CODE_INVALID']]);
  });

  it('refuses the later row that repeats a package and kind of the file, and the later package that claims a code on the national network already given to another', () => {
    const plan = planFileImport(
      procurementFileFormat,
      csv(HEADER, 'GT-01,TBMT-1,BID_OPENING,2026-08-31', 'GT-01,TBMT-1,BID_OPENING,2026-09-01', 'GT-02,TBMT-1,BID_OPENING,2026-08-31', 'GT-01,TBMT-1,BID_CLOSING,2026-08-30'),
    );
    expect(outcome(plan)).toEqual([
      [2, '|GT-01|BID_OPENING'],
      [3, 'ROW_DUPLICATE'],
      [4, 'EXTERNAL_CODE_CONFLICT'],
      [5, '|GT-01|BID_CLOSING'],
    ]);
  });

  it('takes the same package code in two projects as two packages', () => {
    const plan = planFileImport(procurementFileFormat, csv('project_code,package_code,external_code,milestone_kind,actual_at', 'DA-1,GT-01,T-1,BID_OPENING,2026-08-31', 'DA-2,GT-01,T-2,BID_OPENING,2026-08-31'));
    expect(outcome(plan)).toEqual([
      [2, 'DA-1|GT-01|BID_OPENING'],
      [3, 'DA-2|GT-01|BID_OPENING'],
    ]);
  });
});

describe('the moment of a cell and the day of a moment', () => {
  it('reads a day in Vietnam, a Vietnamese date and an ISO date-time with its offset, and nothing else', () => {
    expect(momentOf('2026-08-31')).toBe('2026-08-30T17:00:00.000Z');
    expect(momentOf(' 31/08/2026 ')).toBe('2026-08-30T17:00:00.000Z');
    expect(momentOf('2026-08-31T00:00:00Z')).toBe('2026-08-31T00:00:00.000Z');
    expect(momentOf('2026-08-31T07:30:15.5+07:00')).toBe('2026-08-31T00:30:15.500Z');
    for (const bad of ['', '2026-8-31', '31-08-2026', '2026-08-31T10:00', '2026-13-01', '2026-02-29', '1999-12-31', '2101-01-01', 'yesterday', '2026-08-31 10:00:00Z']) expect(momentOf(bad)).toBeUndefined();
  });

  it('gives the Vietnam calendar day of a moment', () => {
    expect(vietnamDayOf('2026-08-30T17:00:00.000Z')).toBe('2026-08-31');
    expect(vietnamDayOf('2026-08-31T16:59:59.000Z')).toBe('2026-08-31');
  });
});

describe('the order of the milestones of a package (ST-BID-005, MILESTONE_ORDER_INVALID)', () => {
  const held = {
    INVITATION_PUBLISHED: { plannedAt: '2026-08-01T00:00:00.000Z', actualAt: '2026-08-02T00:00:00.000Z' },
    BID_CLOSING: { plannedAt: '2026-08-20T00:00:00.000Z', actualAt: null },
  } as const;

  it('lists the eight kinds in the order they happen', () => {
    expect(MILESTONE_KINDS).toEqual(['INVITATION_PUBLISHED', 'CLARIFICATION_DEADLINE', 'BID_CLOSING', 'BID_OPENING', 'EVALUATION_DONE', 'RESULT_APPROVED', 'RESULT_PUBLISHED', 'CONTRACT_SIGNED']);
  });

  it('accepts a date in order, the same moment for two kinds, and a kind with no date around it', () => {
    expect(milestoneOrderIssue(held, { kind: 'BID_OPENING', plannedAt: '2026-08-20T00:00:00.000Z' })).toBeUndefined();
    expect(milestoneOrderIssue(held, { kind: 'BID_OPENING', actualAt: '2026-09-01T00:00:00.000Z' })).toBeUndefined();
    expect(milestoneOrderIssue({}, { kind: 'CONTRACT_SIGNED', actualAt: '2026-12-01T00:00:00.000Z' })).toBeUndefined();
    expect(milestoneOrderIssue(held, { kind: 'BID_CLOSING', actualAt: '2026-08-02T00:00:00.000Z' })).toBeUndefined();
  });

  it('names the first fault: a later kind before an earlier one, in the planned dates or in the actual ones', () => {
    expect(milestoneOrderIssue(held, { kind: 'BID_OPENING', plannedAt: '2026-08-10T00:00:00.000Z' })).toEqual({ field: 'planned_at', earlier: 'BID_CLOSING', later: 'BID_OPENING' });
    expect(milestoneOrderIssue(held, { kind: 'BID_CLOSING', actualAt: '2026-08-01T00:00:00.000Z' })).toEqual({ field: 'actual_at', earlier: 'INVITATION_PUBLISHED', later: 'BID_CLOSING' });
    expect(milestoneOrderIssue(held, { kind: 'INVITATION_PUBLISHED', plannedAt: '2026-08-25T00:00:00.000Z' })).toEqual({ field: 'planned_at', earlier: 'INVITATION_PUBLISHED', later: 'BID_CLOSING' });
  });

  it('keeps the date it holds when the change leaves a field out, and clears it when the change says null', () => {
    expect(milestoneOrderIssue(held, { kind: 'INVITATION_PUBLISHED', plannedAt: '2026-08-01T00:00:00.000Z' })).toBeUndefined();
    expect(milestoneOrderIssue(held, { kind: 'INVITATION_PUBLISHED', plannedAt: null })).toBeUndefined();
  });
});
