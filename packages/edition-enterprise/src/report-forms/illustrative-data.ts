import { periodRange } from '@machvon/kernel/src/report-layout.ts';
import type { FormPeriod, ReportFigure, ReportFillData, ReportIndicatorDefinition, ReportScalar } from '@machvon/kernel/src/report-layout.ts';
import type { KpiPeriod, KpiUnit } from '@machvon/kernel/src/kpi-register.ts';
import { ENTERPRISE_KPI_SEEDS, kpiPackTexts } from './rules.ts';
import { fillText, textsOf } from './texts.ts';
import { DEMO_FORMS } from './forms.ts';
import type { DemoFormSpec } from './common.ts';

/**
 * Illustrative data for the demo forms (RPT-1): projects, amounts and names that are INVENTED, labelled "(illustrative)" in the names (the Vietnamese words are in `messages/illustrative.vi.json`) and in the organisation, so a demo, a clip or a golden test can fill a form without
 * the customer's numbers. The set the demo uses has 22 capital construction projects, 1 purchase of assets and 9 purchases of fixed assets, plus 6 major repairs for the forms that have that group (the plant form has its own
 * 6 construction projects and 5 major repairs). Deterministic: the same call gives the same records and figures. All amounts are whole millions of dong (written in whole dong), so a scaled sum has no rounding
 * drift; the indicator figures are summed from the records, so the strip of headline figures and the table of a form agree.
 */

export const ILLUSTRATIVE_COUNTS = Object.freeze({ dtxdcb: 22, mstb: 1, mstscd: 9, scl: 6, plantDtxdcb: 6, plantScl: 5 });

/** The invented words of the sample data, from `messages/illustrative.vi.json`: the names of the projects, the kinds, units, schedule assessments, statuses, causes, issues, plans and proposals, the facts of the title block. */
interface IllustrativeTexts {
  illustrativeSuffix: string;
  names: Readonly<Record<'dtxdcb' | 'mstb' | 'mstscd' | 'scl' | 'plantDtxdcb' | 'plantScl', readonly string[]>>;
  kindLabels: Readonly<Record<'dtxdcb' | 'mstb' | 'mstscd' | 'scl', string>>;
  units: readonly string[];
  schedules: readonly string[];
  delayedSchedule: string;
  statuses: readonly string[];
  causes: ReadonlyArray<string | null>;
  issues: ReadonlyArray<string | null>;
  nexts: ReadonlyArray<string | null>;
  proposals: ReadonlyArray<string | null>;
  meta: Readonly<Record<'PARENT_NAME' | 'ORG_NAME' | 'REPORT_DATE_LINE' | 'SIGN_PREPARER' | 'SIGN_CHECKER' | 'SIGN_APPROVER', string>>;
}

const TEXTS = textsOf<IllustrativeTexts>('illustrative');
const NAMES = TEXTS.names;
const KIND_LABEL = TEXTS.kindLabels;
type Kind = keyof typeof KIND_LABEL;
const UNITS = TEXTS.units;
const SCHEDULES = TEXTS.schedules;
const STATUSES = TEXTS.statuses;
const CAUSES = TEXTS.causes;
const ISSUES = TEXTS.issues;
const NEXTS = TEXTS.nexts;
const PROPOSALS = TEXTS.proposals;

const pad = (value: number): string => String(value).padStart(2, '0');
const pick = <T>(list: readonly T[], index: number): T => list[index % list.length] as T;
const dong = (millions: number): string => String(BigInt(Math.round(millions)) * 1_000_000n);
const pct = (value: number, percent: number): number => Math.round((value * percent) / 100);

type Row = { [field: string]: ReportScalar };

/** The records of one group: invented, deterministic, in whole millions of dong turned into whole dong. `months` is how many months of the year the period reaches (for the cumulative figures). */
function records(kind: Kind, names: readonly string[], prefix: string, offset: number, quarter: boolean, months: number): Row[] {
  const factor = quarter ? 3 : 1;
  return names.map((name, i): Row => {
    const k = i + offset;
    const tmdt = 20_000 + ((k * 7_919) % 180_000);
    const planYear = pct(tmdt, 20 + ((k * 13) % 30));
    const planForce = Math.max(1_000, planYear + (((k * 5) % 7) - 2) * 500);
    const execP = pct(planForce, (2 + (k % 5)) * factor);
    const disbP = pct(execP, 60 + ((k * 11) % 40));
    const execYtd = Math.max(execP, pct(planForce, Math.round(((25 + ((k * 17) % 55)) * months) / 10)));
    const disbYtd = Math.max(disbP, pct(execYtd, 55 + ((k * 7) % 40)));
    const execStart = execYtd + pct(tmdt, 5 + (k % 20));
    const disbStart = Math.max(disbYtd, pct(execStart, 70 + (k % 25)));
    const estP = pct(execP, 100 + ((k * 3) % 15));
    const outlook = Math.max(execYtd, pct(planForce, 70 + ((k * 9) % 40)));
    const equity = pct(planForce, 35 + (k % 25));
    const debt = pct(planForce, 20 + ((k * 3) % 20));
    const other = planForce - equity - debt;
    return {
      code: `${prefix}-${pad(i + 1)}`,
      name: `${name}${TEXTS.illustrativeSuffix}`,
      grp: pick(['A', 'B', 'C'], k),
      kind: KIND_LABEL[kind],
      owner_unit: pick(UNITS, k),
      tmdt: dong(tmdt),
      plan_year: dong(planYear),
      plan_force: dong(planForce),
      est_p: dong(estP),
      exec_p: dong(execP),
      disb_p: dong(disbP),
      exec_ytd: dong(execYtd),
      disb_ytd: dong(disbYtd),
      exec_start: dong(execStart),
      disb_start: dong(disbStart),
      outlook: dong(outlook),
      cap_equity: dong(equity),
      cap_debt: dong(debt),
      cap_other: dong(other),
      status: pick(STATUSES, k),
      schedule: pick(SCHEDULES, k),
      cause: pick(CAUSES, k),
      issues: pick(ISSUES, k),
      next: pick(NEXTS, k),
      proposal: pick(PROPOSALS, k),
    };
  });
}

const sumOf = (rows: readonly Row[], field: string): bigint => rows.reduce((total, row) => total + BigInt(String(row[field] ?? '0')), 0n);

/** A percent with four decimals, half up, from whole numbers (the way the figure engine writes a rate); null when the denominator is not above zero. */
function percent4(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const scaled = (numerator * 2_000_000n + denominator) / (2n * denominator);
  const digits = scaled.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** The definitions of the indicators of the pack, written on every fill data (illustrative or from a snapshot). */
export const ENTERPRISE_DEFINITIONS: Readonly<{ [code: string]: ReportIndicatorDefinition }> = Object.freeze(
  Object.fromEntries(
    ENTERPRISE_KPI_SEEDS.map((seed) => [
      seed.code,
      { code: seed.code, name: seed.name, unit: seed.unit as KpiUnit, decimals: seed.decimals, period: seed.period as KpiPeriod, version: 0, formula: seed.formula, source: kpiPackTexts().definitionSource, unverified: true } satisfies ReportIndicatorDefinition,
    ]),
  ),
);

/** The figures of every indicator of the pack, summed from the records of the datasets that make up the report (each record counted once). */
export function illustrativeFigures(rows: readonly Row[], asOf: string): ReportFigure[] {
  const plan = sumOf(rows, 'plan_force');
  const execYtd = sumOf(rows, 'exec_ytd');
  const disbYtd = sumOf(rows, 'disb_ytd');
  const outlook = sumOf(rows, 'outlook');
  const equity = sumOf(rows, 'cap_equity');
  const debt = sumOf(rows, 'cap_debt');
  const other = sumOf(rows, 'cap_other');
  const capital = equity + debt + other;
  const delayed = rows.filter((row) => row.schedule === TEXTS.delayedSchedule).length;
  const figure = (code: string, basis: ReportFigure['basis'], value: ReportScalar): ReportFigure => ({ code, basis, value, asOf });
  return [
    figure('ENT_TOTAL_INVESTMENT', 'AS_OF_END', sumOf(rows, 'tmdt').toString()),
    figure('ENT_PLAN_YEAR', 'FULL_YEAR', sumOf(rows, 'plan_year').toString()),
    figure('ENT_PLAN_IN_FORCE', 'FULL_YEAR', plan.toString()),
    figure('ENT_EXECUTED_PERIOD', 'IN_PERIOD', sumOf(rows, 'exec_p').toString()),
    figure('ENT_DISBURSED_PERIOD', 'IN_PERIOD', sumOf(rows, 'disb_p').toString()),
    figure('ENT_ESTIMATE_PERIOD', 'IN_PERIOD', sumOf(rows, 'est_p').toString()),
    figure('ENT_EXECUTED_YTD', 'YEAR_TO_DATE', execYtd.toString()),
    figure('ENT_DISBURSED_YTD', 'YEAR_TO_DATE', disbYtd.toString()),
    figure('ENT_EXECUTED_SINCE_START', 'AS_OF_END', sumOf(rows, 'exec_start').toString()),
    figure('ENT_DISBURSED_SINCE_START', 'AS_OF_END', sumOf(rows, 'disb_start').toString()),
    figure('ENT_OUTLOOK_YEAR', 'FULL_YEAR', outlook.toString()),
    figure('ENT_CAPITAL_EQUITY', 'FULL_YEAR', equity.toString()),
    figure('ENT_CAPITAL_DEBT', 'FULL_YEAR', debt.toString()),
    figure('ENT_CAPITAL_OTHER', 'FULL_YEAR', other.toString()),
    figure('ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE', percent4(execYtd, plan)),
    figure('ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE', percent4(disbYtd, plan)),
    figure('ENT_RATE_SINCE_START', 'AS_OF_END', percent4(sumOf(rows, 'exec_start'), sumOf(rows, 'tmdt'))),
    figure('ENT_RATE_OUTLOOK_YEAR', 'FULL_YEAR', percent4(outlook, plan)),
    figure('ENT_SHARE_EQUITY', 'FULL_YEAR', percent4(equity, capital)),
    figure('ENT_SHARE_DEBT', 'FULL_YEAR', percent4(debt, capital)),
    figure('ENT_SHARE_OTHER', 'FULL_YEAR', percent4(other, capital)),
    figure('ENT_PROJECTS_TOTAL', 'AS_OF_END', String(rows.length)),
    figure('ENT_PROJECTS_ON_TRACK', 'AS_OF_END', String(rows.length - delayed)),
    figure('ENT_PROJECTS_DELAYED', 'AS_OF_END', String(delayed)),
  ];
}

/** The date line of the signature block: the place, then the day `add` days after `day` as the Vietnamese form writes it (day, month, year in words). */
const reportDateLine = (day: string, add: number): string => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, date + add));
  return fillText(TEXTS.meta.REPORT_DATE_LINE, { day: pad(moved.getUTCDate()), month: pad(moved.getUTCMonth() + 1), year: moved.getUTCFullYear() });
};

/**
 * The data a demo form is filled with for `period`: the datasets the form names (invented projects), the figures summed from them, the definitions of the enterprise indicator pack and the facts of the title block
 * and the signatures (invented names, marked as illustrative figures).
 */
export function illustrativeFillData(form: DemoFormSpec, period: FormPeriod): ReportFillData {
  const quarter = period.kind === 'QUARTER';
  const range = periodRange(period);
  const months = Number(range.to.slice(5, 7));
  const plant = form.layout.code === 'PLANT-PHU-MY';
  const dtxdcb = plant ? records('dtxdcb', NAMES.plantDtxdcb, 'NM-DT', 40, quarter, months) : records('dtxdcb', NAMES.dtxdcb, 'DTXD', 0, quarter, months);
  const mstb = records('mstb', NAMES.mstb, 'MSTB', 22, quarter, months);
  const mstscd = records('mstscd', NAMES.mstscd, 'MSCD', 23, quarter, months);
  const scl = plant ? records('scl', NAMES.plantScl, 'NM-SC', 50, quarter, months) : records('scl', NAMES.scl, 'SCL', 32, quarter, months);
  const pools: { [dataset: string]: Row[] } = { dtxdcb, mstb, mstscd, scl, items: [...dtxdcb, ...mstb, ...mstscd] };
  const datasets: { [dataset: string]: Row[] } = {};
  for (const group of form.groups) datasets[group.dataset] = pools[group.dataset] as Row[];
  const reported = form.groups.flatMap((group) => datasets[group.dataset] as Row[]);
  const day = range.to;
  return {
    period,
    meta: {
      PARENT_NAME: TEXTS.meta.PARENT_NAME,
      ORG_NAME: TEXTS.meta.ORG_NAME,
      REPORT_DATE_LINE: reportDateLine(day, 5),
      SIGN_PREPARER: TEXTS.meta.SIGN_PREPARER,
      SIGN_CHECKER: TEXTS.meta.SIGN_CHECKER,
      SIGN_APPROVER: TEXTS.meta.SIGN_APPROVER,
    },
    definitions: ENTERPRISE_DEFINITIONS,
    figures: illustrativeFigures(reported, day),
    datasets,
  };
}

/** The data of every demo form for one period, by form code. */
export const illustrativeFillDataFor = (period: FormPeriod): { [code: string]: ReportFillData } => Object.fromEntries(DEMO_FORMS.map((form) => [form.layout.code, illustrativeFillData(form, period)]));
