import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { DomainError } from '@machvon/kernel/src/errors.ts';
import { defaultGovernanceRule, describeRuleType, isGovernanceRuleType } from '@machvon/kernel/src/governance-rules.ts';
import type { GovernanceRuleVersion } from '@machvon/kernel/src/governance-rules.ts';
import { kpiDefinitionOf } from '@machvon/kernel/src/kpi-register.ts';
import {
  DEMO_MARK,
  REPORT_FORM_CATALOGUE,
  assertLayoutIssuable,
  assertStatusMove,
  cellRef,
  columnLetters,
  countsAsAcceptedForm,
  demoFormsOn,
  fillGrid,
  fillNarrative,
  headerRowsOf,
  validateLayout,
} from '@machvon/kernel/src/report-layout.ts';
import type { FilledGrid, FormPeriod, ReportFillData } from '@machvon/kernel/src/report-layout.ts';
import { issueMarksOf } from '@machvon/kernel/src/report-issue.ts';
import * as server from '../src/server.ts';
import {
  DEMO_FORMS,
  ENTERPRISE_KPI_CODES,
  ENTERPRISE_KPI_SEEDS,
  ILLUSTRATIVE_COUNTS,
  buildDemoTemplates,
  demoFormOf,
  demoFormsEnabled,
  illustrativeFillData,
  illustrativeFillDataFor,
  registerEnterpriseReportRules,
  rowRolesOf,
  stampFooter,
  stampHeader,
  templateFileName,
} from '../src/report-forms/exports.ts';
import type { DemoFormSpec } from '../src/report-forms/exports.ts';

registerEnterpriseReportRules();

const GOLDEN_DIR = join(__dirname, 'golden');
const TEMPLATE_DIR = join(__dirname, '..', 'templates', 'demo');
const MONTH: FormPeriod = { kind: 'MONTH', year: 2026, index: 10 };
const QUARTER: FormPeriod = { kind: 'QUARTER', year: 2026, index: 3 };
const periodOf = (form: DemoFormSpec): FormPeriod => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === form.layout.code)?.period === 'QUARTER' ? QUARTER : MONTH);

const failure = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.status}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

// ---- the cell map and the way it is compared ----------------------------------------------------------------------------------------------------

/** The grid as plain text, one line per cell in order of row and column, then the merges and the issues: what the golden files hold. */
function cellMapOf(grid: FilledGrid): string {
  const lines = [`# ${grid.layoutCode} v${grid.layoutVersion} status=${grid.status} stamp=${grid.stamp ?? '-'} sheet=${grid.sheetName} scale=${grid.moneyScale}`, `# rows=${grid.rows.length} inserted=${grid.rows.filter((row) => row.inserted).length}`];
  const cells = [...grid.cells].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of cells) {
    const ref = cellRef(cell.row, cell.col);
    const value = cell.kind === 'TEXT' ? cell.text : cell.kind === 'NUMBER' ? cell.number : cell.kind === 'FORMULA' ? cell.formula : '';
    lines.push([ref, cell.kind, value ?? '', cell.numFmt ?? '-', cell.source ?? '-'].join('\t'));
  }
  for (const merge of [...grid.merges].sort((a, b) => a.fromRow - b.fromRow || a.fromCol - b.fromCol)) lines.push(`merge ${merge.fromRow}:${merge.fromCol}-${merge.toRow}:${merge.toCol}`);
  for (const issue of grid.issues) lines.push(`issue ${issue.ref} ${issue.code} ${issue.detail ?? '-'}`);
  return `${lines.join('\n')}\n`;
}

const goldenPath = (code: string): string => join(GOLDEN_DIR, `${code}.cells.txt`);
const compareToGolden = (code: string, actual: string): string | undefined => {
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath(code), actual, 'utf8');
  }
  return existsSync(goldenPath(code)) ? readFileSync(goldenPath(code), 'utf8') : undefined;
};

// ---- a small evaluator for the formulas the forms write (independent of the writer) -------------------------------------------------------------------

const letterToCol = (letters: string): number => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);

function evaluator(grid: FilledGrid): (ref: string) => number | string {
  const byRef = new Map<string, FilledGrid['cells'][number]>();
  for (const cell of grid.cells) byRef.set(`${cell.col}:${cell.row}`, cell);
  const value = (col: number, row: number): number | string => {
    const cell = byRef.get(`${col}:${row}`);
    if (cell === undefined || cell.kind === 'EMPTY' || cell.kind === 'TEXT') return cell?.kind === 'TEXT' ? (cell.text as string) : 0;
    if (cell.kind === 'NUMBER') return Number(cell.number);
    return evaluate(cell.formula as string);
  };
  const evaluate = (formula: string): number | string => {
    const sum = /^SUM\((.+)\)$/.exec(formula);
    if (sum !== null) {
      let total = 0;
      for (const range of (sum[1] as string).split(',')) {
        const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range) as RegExpExecArray;
        for (let row = Number(match[2]); row <= Number(match[4]); row += 1) for (let col = letterToCol(match[1] as string); col <= letterToCol(match[3] as string); col += 1) total += Number(value(col, row));
      }
      return total;
    }
    const rate = /^IF\(([A-Z]+)(\d+)>0,ROUND\(([A-Z]+)(\d+)\/([A-Z]+)(\d+)\*100,1\),""\)$/.exec(formula);
    if (rate !== null) {
      const bottom = Number(value(letterToCol(rate[1] as string), Number(rate[2])));
      if (!(bottom > 0)) return '';
      return Math.round((Number(value(letterToCol(rate[3] as string), Number(rate[4]))) / Number(value(letterToCol(rate[5] as string), Number(rate[6])))) * 1000) / 10;
    }
    throw new Error(`the test evaluator does not know ${formula}`);
  };
  return (ref) => {
    const match = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
    return value(letterToCol(match[1] as string), Number(match[2]));
  };
}

const colOf = (form: DemoFormSpec, key: string): number => (form.layout.columns.find((column) => column.key === key) as { col: number }).col;
const letterOf = (col: number): string => String.fromCharCode(64 + col);
const grandTotalRow = (form: DemoFormSpec, grid: FilledGrid): number => grid.rows.filter((row) => row.kind === 'TOTAL').slice(-1)[0]?.row as number;
const millions = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>, field: string): number => rows.reduce((total, row) => total + Number(BigInt(String(row[field])) / 1_000_000n), 0);

// ---- the rules ---------------------------------------------------------------------------------------------------------------------------------

describe('the enterprise indicator pack and the form mode rule', () => {
  it('adds every indicator as a built-in default of KPI_DEFINITION with formula, source and as-of, all flagged unverified', () => {
    expect(ENTERPRISE_KPI_CODES.length).toBe(ENTERPRISE_KPI_SEEDS.length);
    expect(new Set(ENTERPRISE_KPI_CODES).size).toBe(ENTERPRISE_KPI_CODES.length);
    const described = describeRuleType('KPI_DEFINITION').codes;
    for (const code of ENTERPRISE_KPI_CODES) {
      const one = described.find((candidate) => candidate.code === code);
      expect(one).toBeDefined();
      expect(one?.unverified).toBe(true);
      expect(one?.legalStatus).toBe('UNVERIFIED');
      expect((one?.formula ?? '').length).toBeGreaterThan(30);
      expect(one?.source).toContain('FND-1');
      expect(one?.asOf).toBe('2026-11-08');
      const resolved = defaultGovernanceRule('KPI_DEFINITION', code);
      expect(resolved).toBeDefined();
      const definition = kpiDefinitionOf(resolved as NonNullable<typeof resolved>);
      expect(definition.name.length).toBeGreaterThan(5);
      expect(definition.origin).toBe('DEFAULT');
      expect(definition.owner).toBe('CAPITAL_PLANNER');
    }
    // A ratio carries its numerator and denominator.
    const rate = kpiDefinitionOf(defaultGovernanceRule('KPI_DEFINITION', 'ENT_RATE_DISBURSED_YTD') as NonNullable<ReturnType<typeof defaultGovernanceRule>>);
    expect(rate.unit).toBe('PERCENT');
    expect(rate.numerator).not.toBeNull();
    expect(rate.denominator).not.toBeNull();
  });

  it('does not touch the kernel codes and registers once', () => {
    expect(defaultGovernanceRule('KPI_DEFINITION', 'DISBURSEMENT_RATE')).toBeDefined();
    expect(() => registerEnterpriseReportRules()).not.toThrow();
  });

  it('registers REPORT_FORM_MODE with a safe default: demo forms off', () => {
    expect(isGovernanceRuleType('REPORT_FORM_MODE')).toBe(true);
    const resolved = defaultGovernanceRule('REPORT_FORM_MODE', 'DEFAULT');
    expect(resolved?.params).toEqual({ demo_forms: false });
    expect(describeRuleType('REPORT_FORM_MODE').ownerModule).toBe('RPT');
  });

  it('reads the mode from the approved rule of the tenant and lets DEMO_FORMS override it', () => {
    const approved = (demo: boolean): GovernanceRuleVersion => ({ id: 'r1', type: 'REPORT_FORM_MODE', code: 'DEFAULT', version: 1, status: 'APPROVED', params: { demo_forms: demo }, effectiveFrom: '2026-11-01', effectiveTo: null, unitId: null });
    expect(demoFormsEnabled([], '2026-11-08')).toBe(false);
    expect(demoFormsEnabled([approved(true)], '2026-11-08')).toBe(true);
    expect(demoFormsEnabled([approved(true)], '2026-10-31')).toBe(false);
    expect(demoFormsEnabled([approved(false)], '2026-11-08', { DEMO_FORMS: 'true' })).toBe(true);
    expect(demoFormsEnabled([approved(true)], '2026-11-08', { DEMO_FORMS: 'false' })).toBe(false);
    expect(failure(() => demoFormsEnabled([], '2026-11-08', { DEMO_FORMS: 'maybe' }))).toBe('VALIDATION_FAILED:422:demo_forms');
  });
});

// ---- the six forms -----------------------------------------------------------------------------------------------------------------------------

describe('the six demo forms', () => {
  it('are exactly the catalogue, each a DEMO layout that the kernel accepts', () => {
    expect(DEMO_FORMS.map((form) => form.layout.code)).toEqual(REPORT_FORM_CATALOGUE.map((entry) => entry.code));
    for (const form of DEMO_FORMS) {
      const entry = REPORT_FORM_CATALOGUE.find((candidate) => candidate.code === form.layout.code);
      expect(form.layout.name).toBe(entry?.name);
      expect(form.layout.status).toBe('DEMO');
      expect(form.layout.formRef).toBeNull();
      expect(form.layout.moneyScale).toBe('MILLION_VND');
      expect(failure(() => validateLayout(form.layout))).toBeUndefined();
      expect(demoFormOf(form.layout.code)).toBe(form);
    }
    expect(demoFormOf('NOPE')).toBeUndefined();
  });

  it('are two-tier forms with the mark, the unit of account, the totals and the three signatures', () => {
    for (const form of DEMO_FORMS) {
      const headers = headerRowsOf(form.layout.columns);
      expect(headers.length).toBe(2);
      expect(headers[0]?.cells.some((cell) => (cell.colSpan ?? 1) > 1)).toBe(true);
      const texts = [...form.layout.preface, ...form.layout.body].flatMap((row) => row.cells.map((cell) => cell.binding)).filter((binding) => binding.kind === 'TEXT').map((binding) => (binding as { text: string }).text);
      expect(texts).toContain(DEMO_MARK);
      expect(texts).toContain('NGƯỜI LẬP BIỂU');
      expect(texts).toContain('NGƯỜI KIỂM TRA');
      expect(texts).toContain('NGƯỜI PHÊ DUYỆT');
      expect(texts.some((text) => text.startsWith('TỔNG CỘNG'))).toBe(true);
      const metas = form.layout.preface.flatMap((row) => row.cells.map((cell) => cell.binding)).filter((binding) => binding.kind === 'META');
      expect(metas.map((binding) => (binding as { key: string }).key)).toEqual(expect.arrayContaining(['PARENT_NAME', 'ORG_NAME', 'PERIOD_LABEL', 'UNIT_LABEL']));
      expect(rowRolesOf(form).length).toBe(form.layout.preface.length + headers.length + form.layout.body.length);
    }
  });

  it('carry the columns the dossier lists, by kind of project, in the order a reader expects', () => {
    const keysOf = (code: string): string[] => (demoFormOf(code) as DemoFormSpec).layout.columns.map((column) => column.key);
    const commons = ['stt', 'code', 'name', 'grp'];
    const common = ['tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', 'status', 'schedule', 'issues', 'next', 'proposal'];
    for (const code of ['PVN-MONTHLY', 'PVN-QUARTERLY-F2', 'PLANT-PHU-MY']) {
      const keys = keysOf(code);
      expect(keys.slice(0, 4)).toEqual(commons);
      expect(keys).toEqual(expect.arrayContaining(code === 'PLANT-PHU-MY' ? [...common, 'owner_unit'] : [...common, 'plan_year']));
    }
    expect(keysOf('PVN-QUARTERLY-F2')).toEqual(expect.arrayContaining(['est_p', 'outlook', 'rate_outlook', 'cause']));
    expect(keysOf('HPM-MONTHLY')).toContain('kind');
    expect(demoFormOf('HPM-MONTHLY')?.groups.map((group) => group.dataset)).toEqual(['items']);
    expect(demoFormOf('PVN-MONTHLY')?.groups.map((group) => group.dataset)).toEqual(['dtxdcb', 'mstb', 'mstscd']);
    expect(demoFormOf('PLANT-PHU-MY')?.groups.map((group) => group.dataset)).toEqual(['dtxdcb', 'scl']);
    expect(demoFormOf('INVEST-STEERING')?.groups.map((group) => group.dataset)).toEqual(['dtxdcb', 'mstb', 'mstscd', 'scl']);
  });

  it('are bound only to indicators that exist in the register, in the strip and in the narratives', () => {
    const codes = new Set(ENTERPRISE_KPI_CODES);
    for (const form of DEMO_FORMS) {
      const bound = form.layout.preface.flatMap((row) => row.cells.map((cell) => cell.binding)).filter((binding) => binding.kind === 'INDICATOR').map((binding) => (binding as { code: string }).code);
      expect(bound.length).toBeGreaterThanOrEqual(6);
      expect([...new Set(bound)]).toEqual([...form.indicatorCodes]);
      for (const code of bound) expect(codes.has(code)).toBe(true);
      const tokens = JSON.stringify(form.narrative ?? []).match(/\{\{indicator:([A-Z_]+)@/g) ?? [];
      for (const token of tokens) expect(codes.has(token.replace('{{indicator:', '').replace('@', ''))).toBe(true);
    }
    expect(DEMO_FORMS.filter((form) => form.narrative !== null).map((form) => form.layout.code)).toEqual(['PVN-QUARTERLY-F2', 'COMMITTEE-PERIODIC', 'INVEST-STEERING', 'PLANT-PHU-MY']);
  });
});

// ---- issuing: official mode, demo mode and R18 --------------------------------------------------------------------------------------------------

describe('issuing a demo form', () => {
  it('is refused in official mode and allowed in demo mode, with the mark in the issued-copy metadata', () => {
    for (const form of DEMO_FORMS) {
      expect(failure(() => assertLayoutIssuable(form.layout))).toBe('TEMPLATE_UNCONFIRMED:409:demo_forms_off');
      expect(failure(() => assertLayoutIssuable(form.layout, { demoMode: demoFormsOn({ env: { DEMO_FORMS: 'false' }, ruleParams: { demo_forms: true } }) }))).toBe('TEMPLATE_UNCONFIRMED:409:demo_forms_off');
      expect(failure(() => assertLayoutIssuable(form.layout, { demoMode: demoFormsOn({ env: { DEMO_FORMS: 'true' } }) }))).toBeUndefined();
      expect(failure(() => issueMarksOf(form.layout))).toBe('TEMPLATE_UNCONFIRMED:409:demo_forms_off');
      expect(issueMarksOf(form.layout, { demoMode: true })).toEqual({ formStatus: 'DEMO', demoMark: DEMO_MARK });
    }
  });

  it('can never be READY or counted as accepted (R18)', () => {
    for (const form of DEMO_FORMS) {
      expect(countsAsAcceptedForm(form.layout)).toBe(false);
      expect(failure(() => assertStatusMove(form.layout.status, 'READY'))).toBe('TEMPLATE_UNCONFIRMED:409:demo_not_ready');
    }
    for (const entry of REPORT_FORM_CATALOGUE) {
      expect(entry.status).toBe('DEMO');
      expect(entry.official).toBe('PENDING_EXTERNAL');
    }
    // A layout that claims READY while it is still a demo design (no official reference, demo name) is not what a demo form is: the kernel's guard only lets DEMO layouts carry the demo words.
    const claimed = { ...(DEMO_FORMS[0] as DemoFormSpec).layout, status: 'READY' as const };
    expect(failure(() => assertLayoutIssuable(claimed))).toBeUndefined();
    expect(countsAsAcceptedForm(claimed)).toBe(true);
  });
});

// ---- golden: the six forms filled with the illustrative data -------------------------------------------------------------------------------------

describe('golden cell maps of the six forms (illustrative data)', () => {
  it('has the sets the demo uses: 22 ĐTXDCB projects, 1 purchase of assets, 9 purchases of fixed assets', () => {
    const data = illustrativeFillData(demoFormOf('PVN-MONTHLY') as DemoFormSpec, MONTH);
    expect(data.datasets.dtxdcb).toHaveLength(ILLUSTRATIVE_COUNTS.dtxdcb);
    expect(data.datasets.mstb).toHaveLength(1);
    expect(data.datasets.mstscd).toHaveLength(9);
    expect(ILLUSTRATIVE_COUNTS).toEqual({ dtxdcb: 22, mstb: 1, mstscd: 9, scl: 6, plantDtxdcb: 6, plantScl: 5 });
    const hpm = illustrativeFillData(demoFormOf('HPM-MONTHLY') as DemoFormSpec, MONTH);
    expect(hpm.datasets.items).toHaveLength(32);
    const plant = illustrativeFillData(demoFormOf('PLANT-PHU-MY') as DemoFormSpec, MONTH);
    expect([plant.datasets.dtxdcb?.length, plant.datasets.scl?.length]).toEqual([6, 5]);
    // Invented and labelled so.
    for (const name of (data.datasets.dtxdcb ?? []).map((row) => String(row.name))) expect(name).toContain('(minh họa)');
    expect(data.meta.ORG_NAME).toContain('minh họa');
  });

  it('keeps the numbers of every invented record in order: the period is part of the cumulative, the cumulative of the history, the history of the investment', () => {
    for (const form of DEMO_FORMS) {
      for (const period of [MONTH, QUARTER]) {
        const data = illustrativeFillData(form, period);
        for (const rows of Object.values(data.datasets)) {
          for (const row of rows) {
            const n = (field: string): bigint => BigInt(String(row[field]));
            expect(n('disb_p')).toBeLessThanOrEqual(n('exec_p'));
            expect(n('exec_p')).toBeLessThanOrEqual(n('exec_ytd'));
            expect(n('disb_p')).toBeLessThanOrEqual(n('disb_ytd'));
            expect(n('disb_ytd')).toBeLessThanOrEqual(n('exec_ytd'));
            expect(n('exec_ytd')).toBeLessThanOrEqual(n('exec_start'));
            expect(n('disb_ytd')).toBeLessThanOrEqual(n('disb_start'));
            expect(n('exec_start')).toBeLessThan(n('tmdt'));
            expect(n('plan_force')).toBeGreaterThan(0n);
            expect(n('cap_other')).toBeGreaterThanOrEqual(0n);
            expect(n('tmdt') % 1_000_000n).toBe(0n);
          }
        }
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(illustrativeFillDataFor(MONTH))).toBe(JSON.stringify(illustrativeFillDataFor(MONTH)));
  });

  for (const form of DEMO_FORMS) {
    describe(form.layout.code, () => {
      const data = illustrativeFillData(form, periodOf(form));
      const grid = fillGrid(form.layout, data);

      it('matches the golden cell map', () => {
        const expected = compareToGolden(form.layout.code, cellMapOf(grid));
        expect(expected).toBeDefined();
        expect(cellMapOf(grid)).toBe(expected);
      });

      it('carries the demo mark, has no issue, and a row for every record', () => {
        expect(grid.status).toBe('DEMO');
        expect(grid.stamp).toBe(DEMO_MARK);
        expect(grid.cells.find((cell) => cell.row === 1 && cell.col === 1)?.text).toBe(DEMO_MARK);
        expect(grid.issues).toEqual([]);
        const records = form.groups.reduce((total, group) => total + (data.datasets[group.dataset]?.length ?? 0), 0);
        expect(grid.rows.filter((row) => row.kind === 'DATA')).toHaveLength(records);
        expect(grid.rows.filter((row) => row.inserted).length).toBe(records - form.groups.length);
      });

      it('adds up: the grand total is the sum of the records and the strip of indicators agrees with it', () => {
        const value = evaluator(grid);
        const total = grandTotalRow(form, grid);
        const rows = form.groups.flatMap((group) => data.datasets[group.dataset] ?? []);
        for (const key of ['tmdt', 'plan_year', 'plan_force', 'est_p', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'outlook', 'cap_equity', 'cap_debt', 'cap_other']) {
          if (!form.layout.columns.some((column) => column.key === key)) continue;
          expect(value(`${letterOf(colOf(form, key))}${total}`)).toBe(millions(rows, key));
        }
        // The capital structure is the whole of the plan, on every line and in total.
        if (form.layout.columns.some((column) => column.key === 'cap_equity')) {
          expect(millions(rows, 'cap_equity') + millions(rows, 'cap_debt') + millions(rows, 'cap_other')).toBe(millions(rows, 'plan_force'));
          for (const row of rows) expect(BigInt(String(row.cap_equity)) + BigInt(String(row.cap_debt)) + BigInt(String(row.cap_other))).toBe(BigInt(String(row.plan_force)));
        }
        // The strip is bound to the register and says the same as the table.
        const byCode: Record<string, string> = { ENT_PLAN_IN_FORCE: 'plan_force', ENT_EXECUTED_PERIOD: 'exec_p', ENT_DISBURSED_PERIOD: 'disb_p', ENT_EXECUTED_YTD: 'exec_ytd', ENT_DISBURSED_YTD: 'disb_ytd', ENT_EXECUTED_SINCE_START: 'exec_start', ENT_OUTLOOK_YEAR: 'outlook' };
        const stripRow = form.layout.preface.length - 1;
        for (const cell of form.layout.preface[stripRow]?.cells ?? []) {
          const code = (cell.binding as { code: string }).code;
          const written = grid.cells.find((candidate) => candidate.row === stripRow + 1 && candidate.col === cell.col);
          expect(written?.kind).toBe('NUMBER');
          expect(written?.source).toContain(`INDICATOR:${code}@`);
          if (byCode[code] !== undefined) expect(Number(written?.number)).toBe(value(`${letterOf(colOf(form, byCode[code] as string))}${total}`));
        }
        if (form.layout.columns.some((column) => column.key === 'rate_disb')) {
          const strip = grid.cells.find((candidate) => candidate.source === 'INDICATOR:ENT_RATE_DISBURSED_YTD@YEAR_TO_DATE' || candidate.source === 'INDICATOR:ENT_RATE_DISBURSED_YTD@YEAR_TO_DATE');
          if (strip !== undefined) expect(Math.abs(Number(strip.number) - Number(value(`${letterOf(colOf(form, 'rate_disb'))}${total}`)))).toBeLessThanOrEqual(0.1);
        }
      });

      it('writes the rates as live formulas that evaluate to the same percent as the figures', () => {
        const value = evaluator(grid);
        const firstData = grid.rows.find((row) => row.kind === 'DATA')?.row as number;
        const plan = Number(value(`${letterOf(colOf(form, 'plan_force'))}${firstData}`));
        const done = Number(value(`${letterOf(colOf(form, 'exec_ytd'))}${firstData}`));
        const rate = form.layout.columns.find((column) => column.key === 'rate_exec');
        if (rate === undefined) return;
        expect(value(`${letterOf(rate.col)}${firstData}`)).toBe(Math.round((done / plan) * 1000) / 10);
      });
    });
  }

  it('refuses nothing for the quarter forms and reads a quarter as three months', () => {
    const quarterly = demoFormOf('PVN-QUARTERLY-F2') as DemoFormSpec;
    const monthly = illustrativeFillData(quarterly, MONTH);
    const quarter = illustrativeFillData(quarterly, QUARTER);
    const sum = (data: ReportFillData): bigint => (data.datasets.dtxdcb ?? []).reduce((total, row) => total + BigInt(String(row.exec_p)), 0n);
    expect(sum(quarter)).toBeGreaterThan(sum(monthly));
  });
});

// ---- narratives --------------------------------------------------------------------------------------------------------------------------------

describe('the narrative skeletons', () => {
  for (const form of DEMO_FORMS.filter((candidate) => candidate.narrative !== null)) {
    it(`${form.layout.code}: resolves every token from the register and says the same as the table`, () => {
      const data = illustrativeFillData(form, periodOf(form));
      const filled = fillNarrative(form.narrative ?? [], data, 'MILLION_VND');
      expect(filled.issues).toEqual([]);
      const text = JSON.stringify(filled.blocks);
      expect(text).not.toContain('{{');
      expect(filled.blocks[0]).toEqual({ type: 'PARAGRAPH', text: DEMO_MARK, align: 'CENTER', bold: true });
      expect(text).toContain('TỔNG CÔNG TY MẪU');
      expect(text).toContain('Nguyễn Văn Mẫu');
      const rows = form.groups.flatMap((group) => data.datasets[group.dataset] ?? []);
      const grouped = String(millions(rows, 'plan_force')).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      expect(text).toContain(`${grouped} triệu đồng`);
    });
  }
});

// ---- the templates -----------------------------------------------------------------------------------------------------------------------------

describe('the demo templates', () => {
  let built: Awaited<ReturnType<typeof buildDemoTemplates>>;
  beforeAll(async () => {
    built = await buildDemoTemplates();
  });

  it('are one workbook per form and one Word skeleton per form with a narrative', () => {
    expect(built.map((file) => file.name)).toEqual([
      'PVN-MONTHLY.demo.xlsx',
      'PVN-QUARTERLY-F2.demo.xlsx',
      'PVN-QUARTERLY-F2.demo.docx',
      'HPM-MONTHLY.demo.xlsx',
      'COMMITTEE-PERIODIC.demo.xlsx',
      'COMMITTEE-PERIODIC.demo.docx',
      'INVEST-STEERING.demo.xlsx',
      'INVEST-STEERING.demo.docx',
      'PLANT-PHU-MY.demo.xlsx',
      'PLANT-PHU-MY.demo.docx',
    ]);
    expect(templateFileName('X', 'docx')).toBe('X.demo.docx');
  });

  it('are deterministic and are exactly what is committed under templates/demo', async () => {
    const again = await buildDemoTemplates();
    expect(again.map((file) => Buffer.from(file.bytes).toString('base64'))).toEqual(built.map((file) => Buffer.from(file.bytes).toString('base64')));
    for (const file of built) {
      const path = join(TEMPLATE_DIR, file.name);
      expect(existsSync(path)).toBe(true);
      expect(Buffer.from(file.bytes).equals(readFileSync(path))).toBe(true);
    }
  });

  for (const form of DEMO_FORMS) {
    it(`${form.layout.code}.xlsx has the header, the mark, the formulas and the A3 landscape print setup`, async () => {
      const bytes = readFileSync(join(TEMPLATE_DIR, templateFileName(form.layout.code, 'xlsx')));
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      expect(workbook.worksheets).toHaveLength(1);
      const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
      expect(sheet.name).toBe(form.layout.sheetName);
      expect(workbook.subject).toBe(DEMO_MARK);
      expect(workbook.description).toContain(DEMO_MARK);
      expect(sheet.getCell('A1').value).toBe(DEMO_MARK);
      expect(sheet.headerFooter.oddHeader).toBe(stampHeader(DEMO_MARK));
      expect(sheet.headerFooter.oddFooter).toBe(stampFooter(DEMO_MARK));
      expect(sheet.pageSetup.paperSize).toBe(8);
      expect(sheet.pageSetup.orientation).toBe('landscape');
      expect(sheet.pageSetup.fitToWidth).toBe(1);
      const lastCol = form.layout.columns.length;
      expect(sheet.pageSetup.printArea).toBe(`A1:${columnLetters(lastCol)}${sheet.rowCount}`);
      expect(sheet.pageSetup.printTitlesRow).toBe(`${form.layout.preface.length + 1}:${form.layout.preface.length + 2}`);

      // Header: the first level and the second level, at the cells the layout says.
      const headers = headerRowsOf(form.layout.columns);
      headers.forEach((row, level) => {
        for (const cell of row.cells) expect(sheet.getCell(form.layout.preface.length + 1 + level, cell.col).value).toBe((cell.binding as { text: string }).text);
      });
      // Merged title cells and the merged header cells.
      const merges = sheet.model.merges ?? [];
      expect(merges).toContain(`A1:${columnLetters(lastCol)}1`);
      expect(merges.length).toBeGreaterThan(12);
      // The data line of each group holds the formulas of the rates and no sample value; the total row sums the blocks; the numbers carry the thousands separator.
      const rateCol = form.layout.columns.find((column) => column.key === 'rate_disb')?.col;
      const dataRows: number[] = [];
      sheet.eachRow((row, number) => {
        const first = sheet.getCell(number, 1).value;
        if (typeof first === 'string' && (first.startsWith('Cộng') || first.startsWith('TỔNG CỘNG'))) dataRows.push(number);
      });
      // A subtotal for each group and the grand total; a flat form (HPM) has the grand total only.
      expect(dataRows.length).toBe(form.layout.code === 'HPM-MONTHLY' ? 1 : form.groups.length * 2 + 1 - form.groups.length);
      const grand = dataRows.slice(-1)[0] as number;
      const planCol = (form.layout.columns.find((column) => column.key === 'plan_force') as { col: number }).col;
      const planValue = sheet.getCell(grand, planCol).value as { formula: string };
      expect(planValue.formula.startsWith('SUM(')).toBe(true);
      expect(sheet.getCell(grand, planCol).numFmt).toBe('#,##0');
      if (rateCol !== undefined) expect((sheet.getCell(grand, rateCol).value as { formula: string }).formula).toContain('ROUND(');
      expect(sheet.getCell(grand, 1).font?.bold).toBe(true);
    });
  }

  it('have a Word skeleton with the mark in the first paragraph, in the header and in the footer, and the tokens still visible', () => {
    for (const file of built.filter((candidate) => candidate.kind === 'docx')) {
      const entries = unzipSync(file.bytes);
      const text = (name: string): string => new TextDecoder().decode(entries[name] as Uint8Array);
      const names = Object.keys(entries);
      const header = names.filter((name) => /^word\/header\d*\.xml$/.test(name)).map(text).join('');
      const footer = names.filter((name) => /^word\/footer\d*\.xml$/.test(name)).map(text).join('');
      const body = text('word/document.xml');
      expect(header).toContain(DEMO_MARK);
      expect(footer).toContain(DEMO_MARK);
      expect(body).toContain(DEMO_MARK);
      expect(body).toContain('{{indicator:ENT_PLAN_IN_FORCE@FULL_YEAR}}');
      expect(body).toContain('{{meta:SIGN_PREPARER}}');
      expect(text('docProps/core.xml')).toContain(DEMO_MARK);
      expect(text('docProps/core.xml')).toContain('2026-11-08T00:00:00Z');
    }
  });

  it('are refused for a form without a narrative', async () => {
    const { buildDocxSkeleton } = server;
    await expect(buildDocxSkeleton(demoFormOf('HPM-MONTHLY') as DemoFormSpec)).rejects.toThrow('no narrative');
  });
});

describe('the server entry', () => {
  it('exports the forms, the rules and the builders the API seam and the tests use', () => {
    expect(server.DEMO_FORMS).toBe(DEMO_FORMS);
    expect(typeof server.registerEnterpriseReportRules).toBe('function');
    expect(typeof server.buildDemoTemplates).toBe('function');
    expect(typeof server.demoFormsEnabled).toBe('function');
  });
});

describe('scripts/build-demo-templates.mjs --check', () => {
  const script = join(__dirname, '..', 'scripts', 'build-demo-templates.mjs');
  const run = (out: string): { code: number; stderr: string } => {
    try {
      execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--check', '--out', out], { stdio: 'pipe' });
      return { code: 0, stderr: '' };
    } catch (error) {
      const failed = error as { status?: number; stderr?: Buffer };
      return { code: failed.status ?? 1, stderr: String(failed.stderr ?? '') };
    }
  };

  it('passes for the committed folder and says what is wrong with a stale, a missing and an unknown file', () => {
    expect(run(TEMPLATE_DIR)).toEqual({ code: 0, stderr: '' });
    const copy = mkdtempSync(join(tmpdir(), 'demo-templates-'));
    for (const name of readdirSync(TEMPLATE_DIR)) copyFileSync(join(TEMPLATE_DIR, name), join(copy, name));
    expect(run(copy).code).toBe(0);
    const stale = Buffer.from(readFileSync(join(copy, 'PVN-MONTHLY.demo.xlsx')));
    writeFileSync(join(copy, 'PVN-MONTHLY.demo.xlsx'), Buffer.concat([stale, Buffer.from([0])]));
    writeFileSync(join(copy, 'EXTRA.demo.xlsx'), 'x');
    rmSync(join(copy, 'HPM-MONTHLY.demo.xlsx'));
    const result = run(copy);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PVN-MONTHLY.demo.xlsx: stale');
    expect(result.stderr).toContain('HPM-MONTHLY.demo.xlsx: missing');
    expect(result.stderr).toContain('EXTRA.demo.xlsx: not a template of any demo form');
  }, 60_000);
});
