import { EWS_CRITICAL_CODE, EWS_NO_DATA_CODE, EWS_OVERDUE_CODE, EWS_RATE_CODE } from '../src/analytics-rule-defaults';
import { csvOf, xlsxOf } from '../src/dis-export';
import { defaultGovernanceRule } from '../src/governance-rules';
import { buildHomeExportDocument } from '../src/home-export';
import type { HomeFigureRow } from '../src/home-export';
import { displayKpiValue, kpiDefinitionOf } from '../src/kpi-register';
import { evaluateRag, ragFactorInputs, ragModelFromResolver } from '../src/rag-explain';
import { readTabularFile } from '../src/tabular-file';

const value = (inputs: ReturnType<typeof ragFactorInputs>, code: string): number | null => inputs.find((input) => input.code === code)?.value ?? null;

describe('ragFactorInputs: what is read of a unit', () => {
  const facts = { projects: 4, projectsWithoutData: 1, planPmVnd: '1000', treasuryVnd: '500', criticalWarnings: 2, overdueExplanations: 0 };

  it('reads the rate over the pace of the year, the counts, and the share of projects with no Treasury figure', () => {
    // On 2027-07-02 (day 183 of 365) the pace is 50.136...%: a rate of 50% is 0.997 of the pace.
    const inputs = ragFactorInputs(facts, '2027-07-02');
    expect(value(inputs, EWS_RATE_CODE)).toBeCloseTo(50 / ((183 / 365) * 100), 6);
    expect(value(inputs, EWS_CRITICAL_CODE)).toBe(2);
    expect(value(inputs, EWS_OVERDUE_CODE)).toBe(0);
    expect(value(inputs, EWS_NO_DATA_CODE)).toBe(25);
  });

  it('has no rate when the Treasury booked nothing or the plan is nothing, and no share for a unit without projects (never 0)', () => {
    expect(value(ragFactorInputs({ ...facts, treasuryVnd: null }, '2027-07-02'), EWS_RATE_CODE)).toBeNull();
    expect(value(ragFactorInputs({ ...facts, planPmVnd: '0' }, '2027-07-02'), EWS_RATE_CODE)).toBeNull();
    expect(value(ragFactorInputs({ ...facts, projects: 0, projectsWithoutData: 0 }, '2027-07-02'), EWS_NO_DATA_CODE)).toBeNull();
  });

  it('keeps a count that could not be read as no value, so the factor takes no part', () => {
    const inputs = ragFactorInputs({ ...facts, criticalWarnings: null }, '2027-07-02');
    expect(value(inputs, EWS_CRITICAL_CODE)).toBeNull();
  });

  it('judges a unit with the built-in model: a unit far behind the pace with critical warnings is red, one on pace with nothing open is green', () => {
    const model = ragModelFromResolver((code) => defaultGovernanceRule(code.startsWith('EWS_SCORE') ? 'RAG_THRESHOLDS' : 'RAG_THRESHOLDS', code));
    const behind = evaluateRag(model, ragFactorInputs({ projects: 2, projectsWithoutData: 1, planPmVnd: '1000', treasuryVnd: '100', criticalWarnings: 3, overdueExplanations: 3 }, '2027-07-02'));
    expect(behind.band).toBe('RED');
    expect(behind.reasons.length).toBeGreaterThan(0);
    expect(behind.reasons.length).toBeLessThanOrEqual(3);
    const fine = evaluateRag(model, ragFactorInputs({ projects: 5, projectsWithoutData: 0, planPmVnd: '1000', treasuryVnd: '600', criticalWarnings: 0, overdueExplanations: 0 }, '2027-07-02'));
    expect(fine.band).toBe('GREEN');
    expect(fine.score).toBe(0);
    // A unit that has nothing the factors can read is "chưa đủ dữ liệu", not green.
    const empty = evaluateRag(model, ragFactorInputs({ projects: 0, projectsWithoutData: 0, planPmVnd: '0', treasuryVnd: null, criticalWarnings: null, overdueExplanations: null }, '2027-07-02'));
    expect(empty.band).toBe('NO_DATA');
    expect(empty.score).toBeNull();
  });

  it('names the version of each rule that decided, and refuses a model with a rule nobody defined', () => {
    const model = ragModelFromResolver((code) => defaultGovernanceRule('RAG_THRESHOLDS', code));
    expect(Object.keys(model.versions).sort()).toEqual([EWS_CRITICAL_CODE, EWS_NO_DATA_CODE, EWS_OVERDUE_CODE, EWS_RATE_CODE, 'EWS_SCORE'].sort());
    expect(Object.values(model.versions).every((version) => version === 0)).toBe(true);
    expect(model.unverified).toBe(true);
    expect(() => ragModelFromResolver(() => undefined)).toThrow();
  });
});

describe('the file of the figures of the command center', () => {
  const definition = kpiDefinitionOf(defaultGovernanceRule('KPI_DEFINITION', 'DISBURSEMENT_RATE_PM') as NonNullable<ReturnType<typeof defaultGovernanceRule>>);
  const rows: HomeFigureRow[] = [
    { code: 'DISBURSEMENT_RATE_PM', name: definition.name, displayValue: displayKpiValue('62.5', definition), unit: 'PERCENT', numerator: '625', denominator: '1000', nullReason: null, flags: ['UNVERIFIED_DEFINITION'], certification: 'CERTIFIED', definitionVersion: 0, asOfDate: '2027-10-12', formula: definition.formula, source: definition.source, owner: definition.owner },
    { code: 'DISBURSED_TREASURY', name: 'Số Kho bạc đã chi lũy kế', displayValue: null, unit: 'VND', numerator: null, denominator: null, nullReason: 'NOT_CERTIFIED', flags: ['NOT_CERTIFIED'], certification: 'DRAFT', definitionVersion: 2, asOfDate: '2027-10-12', formula: '=SUM(A1)', source: 's', owner: 'o' },
  ];
  const document = buildHomeExportDocument({ snapshotId: 's-1', asOfDate: '2027-10-12', treasuryCutoffDate: '2027-10-11', definitionStatus: 'PROPOSED_PENDING_SIGNOFF', scopeText: 'all', createdAt: new Date('2027-10-15T03:00:00Z'), rows });

  it('writes the value exactly as the screen does and an empty cell with its reason, never 0', () => {
    expect(document.rows[0]?.[2]).toBe('62.50');
    expect(document.rows[1]?.[2]).toBe('');
    expect(document.rows[1]?.[6]).toBe('NOT_CERTIFIED');
    expect(document.notice).not.toBeNull();
  });

  it('reads back from CSV and from XLSX to the same cells (the three channels agree)', () => {
    const fromCsv = readTabularFile(new Uint8Array(Buffer.from(csvOf(document), 'utf8')));
    const fromXlsx = readTabularFile(xlsxOf(document));
    const cells = (file: ReturnType<typeof readTabularFile>): string[][] => file.rows.filter((row) => row[0] === 'DISBURSEMENT_RATE_PM' || row[0] === 'DISBURSED_TREASURY');
    expect(fromCsv.format).toBe('CSV');
    expect(fromXlsx.format).toBe('XLSX');
    expect(cells(fromXlsx)).toEqual(cells(fromCsv));
  });

  it('does not let a cell be read as a formula by a spreadsheet', () => {
    const csv = csvOf(document);
    expect(csv).toContain("'=SUM(A1)");
  });
});
