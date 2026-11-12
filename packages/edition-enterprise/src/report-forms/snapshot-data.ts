import type { EnterpriseFigureReader } from '@machvon/kernel/src/enterprise-snapshot.ts';
import type { ProjectNarrativeText } from '@machvon/kernel/src/ent-narrative.ts';
import { ratioOf } from '@machvon/kernel/src/fnd-figures.ts';
import { periodRange } from '@machvon/kernel/src/report-layout.ts';
import type { FormPeriod, ReportFigure, ReportFillData, ReportScalar } from '@machvon/kernel/src/report-layout.ts';
import type { ReaderScope } from '@machvon/kernel/src/enterprise-snapshot.ts';
import type { Measure } from '@machvon/kernel/src/fnd-taxonomy.ts';
import type { DemoFormSpec } from './common.ts';
import { ENTERPRISE_DEFINITIONS } from './illustrative-data.ts';
import { fillText, textsOf } from './texts.ts';

/**
 * The six demo forms filled from a frozen enterprise period snapshot (ENT-3a, review decision R21): every number is read through `EnterpriseFigureReader`, the only reader of the snapshot, so a form, the screens of the
 * leaders and the push to HPM never disagree. The layouts stay DEMO until the official forms arrive (R18); only the source of the figures changes. A figure nobody has stays empty (null), never zero, and a rate is the
 * sum of its numerators over the sum of its denominators. The project kinds (capital construction, purchase of equipment, repairs) and the schedule texts are not in the snapshot yet (lanes ENT-3b and ENT-3e): every
 * project is listed in the first group of the form and the text columns stay empty.
 */

/** The id under which the API registers the provider that loads the frozen snapshot for these forms. */
export const ENTERPRISE_SNAPSHOT_PROVIDER = 'ENT_SNAPSHOT';

/** What the report prints about a project and its unit; the snapshot holds ids only. */
export interface SnapshotProjectName {
  code: string;
  name: string;
  group: string | null;
  unitName: string;
}

interface SnapshotTexts {
  reportDateLine: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The date line of the signature block: the day five days after the end of the period, as the Vietnamese form writes it. */
function reportDateLine(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, date + 5));
  return fillText(textsOf<SnapshotTexts>('snapshot').reportDateLine, { day: pad(moved.getUTCDate()), month: pad(moved.getUTCMonth() + 1), year: moved.getUTCFullYear() });
}

const DISBURSED: Measure = 'DISBURSED';
const EXECUTED: Measure = 'EXECUTED';

/** The row of one project in the datasets of a form. */
function rowOf(reader: EnterpriseFigureReader, projectId: string, name: SnapshotProjectName): Record<string, ReportScalar> {
  const scope: ReaderScope = { projectIds: [projectId] };
  const amount = (measure: Measure, code: Parameters<EnterpriseFigureReader['amountOf']>[2], classCode: string | null = null): ReportScalar => reader.amountOf(scope, measure, code, classCode);
  return {
    code: name.code,
    name: name.name,
    grp: name.group,
    kind: null,
    owner_unit: name.unitName,
    tmdt: reader.totalInvestment(scope),
    plan_year: amount(DISBURSED, 'PLAN_YEAR'),
    plan_force: amount(DISBURSED, 'PLAN_IN_FORCE'),
    est_p: amount(EXECUTED, 'ESTIMATE_AS_REPORTED'),
    exec_p: amount(EXECUTED, 'ACTUAL'),
    disb_p: amount(DISBURSED, 'ACTUAL'),
    exec_ytd: amount(EXECUTED, 'CUMULATIVE_YTD'),
    disb_ytd: amount(DISBURSED, 'CUMULATIVE_YTD'),
    exec_start: amount(EXECUTED, 'CUMULATIVE_SINCE_START'),
    disb_start: amount(DISBURSED, 'CUMULATIVE_SINCE_START'),
    outlook: amount(EXECUTED, 'ESTIMATE_YEAR'),
    cap_equity: amount(DISBURSED, 'PLAN_IN_FORCE', 'EQUITY'),
    cap_debt: amount(DISBURSED, 'PLAN_IN_FORCE', 'LOAN'),
    cap_other: amount(DISBURSED, 'PLAN_IN_FORCE', 'OTHER'),
    status: null,
    schedule: null,
    cause: null,
    issues: null,
    next: null,
    proposal: null,
  };
}

/** The headline figures of the strip and the Word narrative: sums over the whole snapshot, each rate sum over sum, an absent figure null. */
export function snapshotFigures(reader: EnterpriseFigureReader, asOf: string): ReportFigure[] {
  const all: ReaderScope = {};
  const money = (measure: Measure, code: Parameters<EnterpriseFigureReader['amountOf']>[2], classCode: string | null = null): string | null => reader.amountOf(all, measure, code, classCode);
  const plan = money(DISBURSED, 'PLAN_IN_FORCE');
  const rate = (numerator: string | null, denominator: string | null): string | null => ratioOf(numerator, denominator).ratePct;
  const equity = money(DISBURSED, 'PLAN_IN_FORCE', 'EQUITY');
  const debt = money(DISBURSED, 'PLAN_IN_FORCE', 'LOAN');
  const other = money(DISBURSED, 'PLAN_IN_FORCE', 'OTHER');
  const outlook = money(EXECUTED, 'ESTIMATE_YEAR');
  const figure = (code: string, basis: ReportFigure['basis'], value: ReportScalar): ReportFigure => ({ code, basis, value, asOf });
  return [
    figure('ENT_TOTAL_INVESTMENT', 'AS_OF_END', reader.totalInvestment(all)),
    figure('ENT_PLAN_YEAR', 'FULL_YEAR', money(DISBURSED, 'PLAN_YEAR')),
    figure('ENT_PLAN_IN_FORCE', 'FULL_YEAR', plan),
    figure('ENT_EXECUTED_PERIOD', 'IN_PERIOD', money(EXECUTED, 'ACTUAL')),
    figure('ENT_DISBURSED_PERIOD', 'IN_PERIOD', money(DISBURSED, 'ACTUAL')),
    figure('ENT_ESTIMATE_PERIOD', 'IN_PERIOD', money(EXECUTED, 'ESTIMATE_AS_REPORTED')),
    figure('ENT_EXECUTED_YTD', 'YEAR_TO_DATE', money(EXECUTED, 'CUMULATIVE_YTD')),
    figure('ENT_DISBURSED_YTD', 'YEAR_TO_DATE', money(DISBURSED, 'CUMULATIVE_YTD')),
    figure('ENT_EXECUTED_SINCE_START', 'AS_OF_END', money(EXECUTED, 'CUMULATIVE_SINCE_START')),
    figure('ENT_DISBURSED_SINCE_START', 'AS_OF_END', money(DISBURSED, 'CUMULATIVE_SINCE_START')),
    figure('ENT_OUTLOOK_YEAR', 'FULL_YEAR', outlook),
    figure('ENT_CAPITAL_EQUITY', 'FULL_YEAR', equity),
    figure('ENT_CAPITAL_DEBT', 'FULL_YEAR', debt),
    figure('ENT_CAPITAL_OTHER', 'FULL_YEAR', other),
    figure('ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE', rate(money(EXECUTED, 'CUMULATIVE_YTD'), plan)),
    figure('ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE', rate(money(DISBURSED, 'CUMULATIVE_YTD'), plan)),
    figure('ENT_RATE_SINCE_START', 'AS_OF_END', rate(money(EXECUTED, 'CUMULATIVE_SINCE_START'), reader.totalInvestment(all))),
    figure('ENT_RATE_OUTLOOK_YEAR', 'FULL_YEAR', rate(outlook, plan)),
    figure('ENT_SHARE_EQUITY', 'FULL_YEAR', rate(equity, plan)),
    figure('ENT_SHARE_DEBT', 'FULL_YEAR', rate(debt, plan)),
    figure('ENT_SHARE_OTHER', 'FULL_YEAR', rate(other, plan)),
    figure('ENT_PROJECTS_TOTAL', 'AS_OF_END', String(reader.projectIds().length)),
    // The schedule assessment of a project is not in the snapshot: the two counts stay empty until it is (a count of nothing is not zero).
    figure('ENT_PROJECTS_ON_TRACK', 'AS_OF_END', null),
    figure('ENT_PROJECTS_DELAYED', 'AS_OF_END', null),
  ];
}

/**
 * The fill data of one demo form for one period, from the frozen snapshot read by `reader`. `names` has the code and the name of every project of the snapshot; `orgName` is the name printed in the title block. The
 * facts of the signature block that the system cannot know (the parent group, the people who sign) are left empty for the people to write. `narratives` are the words the units wrote and the approver accepted for the period
 * (ENT-3b): the Word document lays them out at the token of its skeleton; without them the token says there is none, nothing is invented.
 */
export function snapshotFillData(
  form: DemoFormSpec,
  period: FormPeriod,
  reader: EnterpriseFigureReader,
  names: ReadonlyMap<string, SnapshotProjectName>,
  orgName: string,
  narratives?: readonly ProjectNarrativeText[],
): ReportFillData {
  const day = periodRange(period).to;
  const rows = reader
    .projectIds()
    .map((projectId) => ({ projectId, name: names.get(projectId) ?? { code: projectId, name: projectId, group: null, unitName: '' } }))
    .sort((left, right) => left.name.code.localeCompare(right.name.code) || left.projectId.localeCompare(right.projectId))
    .map((one) => rowOf(reader, one.projectId, one.name));
  const first = form.groups[0]?.dataset;
  const datasets: { [dataset: string]: Array<Record<string, ReportScalar>> } = {};
  for (const group of form.groups) datasets[group.dataset] = group.dataset === first || group.dataset === 'items' ? rows : [];
  return {
    period,
    meta: { PARENT_NAME: '', ORG_NAME: orgName, REPORT_DATE_LINE: reportDateLine(day), SIGN_PREPARER: '', SIGN_CHECKER: '', SIGN_APPROVER: '' },
    definitions: ENTERPRISE_DEFINITIONS,
    figures: snapshotFigures(reader, reader.view.asOfDate),
    datasets,
    ...(narratives === undefined ? {} : { narratives }),
  };
}
