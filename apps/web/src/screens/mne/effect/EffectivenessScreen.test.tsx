import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ui_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../../prj/test-support';
import type { Harness } from '../../prj/test-support';
import EffectivenessScreen from './EffectivenessScreen';

const words = ui_ as Record<string, string>;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), words[key] ?? key);
const ROUTE = routeOf('MNE-11', 'FR-MNE-11');
const PROJECT = line(1).id;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SET = uuid(100);
const ASSESSMENT = uuid(200);
const OK = { operation_id: 'o', status: 'OK', resource_version: 2, resource_id: 'x' };
const refusal = (code: string, status = 409, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const person = (n: number, name: string | null) => ({ membership_id: uuid(n), display_name: name });

afterEach(cleanup);

const measured = { measurement_id: uuid(300), value: '60', measured_on: '2027-03-01', method_note: 'Household survey', evidence_document_id: null, recorded_at: '2027-03-02T01:00:00.000Z' };
const indicator = (code: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid(400 + code.length),
  code,
  name: `Indicator ${code}`,
  unit: '%',
  direction: 'HIGHER_IS_BETTER',
  baseline_value: '40',
  baseline_on: '2026-01-01',
  target_value: '80',
  measure_after_months: 12,
  data_source: 'Household survey',
  formula: 'Share of households served',
  actual: measured,
  variance: { variance_value: '-20', variance_pct: '-25.00', achievement_pct: '50.00', basis: 'BASELINE_TO_TARGET', band: 'MISSED' },
  ...overrides,
});
const notMeasured = (code: string) => indicator(code, { actual: null, variance: { variance_value: null, variance_pct: null, achievement_pct: null, basis: 'NONE', band: 'NOT_MEASURED' } });
const met = (code: string) => indicator(code, { actual: { ...measured, value: '85' }, variance: { variance_value: '5', variance_pct: '6.25', achievement_pct: '112.50', basis: 'BASELINE_TO_TARGET', band: 'MET' } });

const targetSet = (status: 'FIXED' | 'DRAFT', overrides: Record<string, unknown> = {}) => ({
  id: SET,
  version_no: status === 'FIXED' ? 2 : 3,
  status,
  basis: 'Decision 12 approving the project',
  basis_document_id: null,
  supersedes_id: null,
  supersede_reason: null,
  drafted_by: person(1, 'Nguyễn Văn An'),
  drafted_at: '2026-02-01T01:00:00.000Z',
  fixed_by: status === 'FIXED' ? person(2, 'Trần Thị Bình') : null,
  fixed_at: status === 'FIXED' ? '2026-02-02T01:00:00.000Z' : null,
  fixed_on: status === 'FIXED' ? '2026-02-02' : null,
  version: status === 'FIXED' ? 5 : 7,
  indicators: [indicator('SERVED'), notMeasured('POWER'), met('WATER')],
  ...overrides,
});

const calendarEntry = (kind: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid(500 + kind.length),
  kind,
  anchor: 'COMPLETION',
  anchor_on: '2027-01-01',
  months: 3,
  due_on: '2027-04-01',
  required: true,
  status: 'PLANNED',
  state: 'UPCOMING',
  days_late: 0,
  assessment_id: null,
  rule_code: 'GROUP_B',
  rule_version: 'built-in:1',
  rule_unverified: true,
  ...overrides,
});

const assessmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: ASSESSMENT,
  kind: 'FINAL',
  status: 'SUBMITTED',
  as_of: '2027-04-02',
  conclusion: 'PARTIALLY_SATISFACTORY',
  summary: 'Two of three targets are within reach',
  lines: [{ code: 'SERVED', name: 'Indicator SERVED', unit: '%', direction: 'HIGHER_IS_BETTER', baseline_value: '40', target_value: '80', actual_value: '60', measured_on: '2027-03-01', variance_value: '-20', variance_pct: '-25.00', achievement_pct: '50.00', basis: 'BASELINE_TO_TARGET', band: 'MISSED' }],
  policy_version: 'built-in:1',
  policy_unverified: true,
  calendar_entry_id: null,
  submitted_by: person(1, 'Nguyễn Văn An'),
  submitted_at: '2027-04-02T01:00:00.000Z',
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  version: 9,
  ...overrides,
});

const policy = (overrides: Record<string, unknown> = {}) => ({
  name: 'EFFECT_POLICY',
  code: 'DEFAULT',
  version: 'built-in:1',
  unverified: true,
  formula: 'Achievement runs from the baseline to the target',
  source: 'Governance rule registry',
  as_of: '2026-11-08',
  legal_status: 'UNVERIFIED',
  owner: 'MNE',
  params: { met_at_pct: 100, partly_at_pct: 70, draft_statuses: ['BUDGETED'], fix_statuses: ['BUDGETED'], measure_statuses: ['COMPLETED'] },
  ...overrides,
});

const CAN_NONE = { draft: false, fix: false, measure: false, generate_calendar: false, assess: false, decide: false };
const CAN_ALL = { draft: true, fix: true, measure: true, generate_calendar: true, assess: true, decide: true };

const view = (overrides: Record<string, unknown> = {}) => ({
  project: { id: PROJECT, code: 'DA-2026-001', name: 'Dự án số 1', status: 'COMPLETED', project_group: 'B' },
  policy: policy(),
  fixed: targetSet('FIXED'),
  draft: null,
  superseded: [{ id: uuid(600), version_no: 1, fixed_on: '2026-01-10' }],
  measurements: [],
  calendar: [],
  assessments: [],
  suggested_conclusion: 'PARTIALLY_SATISFACTORY',
  can: CAN_ALL,
  as_of: '2026-11-08',
  ...overrides,
});

type Answer = unknown | ((input: Record<string, unknown> | undefined) => unknown);

function open(answers: Record<string, Answer>, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  const h = client(world(), command);
  const previous = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    const answer = answers[operation];
    if (answer === undefined) return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
    const value = typeof answer === 'function' ? (answer as (given: unknown) => unknown)(input) : answer;
    return value instanceof Error ? Promise.reject(value) : value instanceof Promise ? value : Promise.resolve(value);
  });
  return h;
}

const show = (h: Harness, options: { mode?: 'FULL' | 'READ_ONLY'; id?: boolean } = {}) =>
  mount(<EffectivenessScreen route={ROUTE} />, h, { permissions: ['project.read'], ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/mne/mne-11${options.id === false ? '' : `?id=${PROJECT}`}` });

const rowOf = (selector: string) =>
  waitFor(() => {
    const found = document.querySelector(selector);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
const action = (name: string) => document.querySelector(`button[data-action="${name}"]`) as HTMLButtonElement | null;
const buttonOf = (name: string) =>
  waitFor(() => {
    const found = action(name);
    expect(found).not.toBeNull();
    return found as HTMLButtonElement;
  });
const infoButtons = (root: HTMLElement) => within(root).queryAllByRole('button', { name: /^Công thức và nguồn của/ });
const field = (dialog: HTMLElement, id: string) => dialog.querySelector(`#${id}`) as HTMLInputElement;
const type = (element: HTMLElement | null, value: string): void => {
  fireEvent.change(element as HTMLElement, { target: { value } });
};
const sent = (h: Harness, operation: string) => h.command.mock.calls.filter(([name]) => name === operation).map(([, input]) => input as Record<string, unknown>);
const dialogError = (): string | undefined => screen.getByRole('dialog').querySelector('.ui-dialog__error')?.textContent ?? undefined;

describe('EffectivenessScreen (MNE-11): reading', () => {
  it('asks for a project when the address names none, lists the projects to choose from and reads nothing', async () => {
    const h = open({});
    show(h, { id: false });
    expect((await screen.findByTestId('no-project')).textContent).toBe(text('mr1.effect.noProject'));
    expect(h.read.mock.calls.filter(([name]) => name === 'getProjectEffectiveness')).toHaveLength(0);
    await waitFor(() => expect(within(screen.getByTestId('project-picker')).getAllByRole('option').length).toBeGreaterThan(1));
  });

  it('reads the project the picker chooses', async () => {
    const h = open({ getProjectEffectiveness: view() });
    show(h, { id: false });
    await waitFor(() => expect(within(screen.getByTestId('project-picker')).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.change(screen.getByTestId('project-picker'), { target: { value: PROJECT } });
    await rowOf('[data-indicator="SERVED"]');
    expect(h.read.mock.calls.find(([name]) => name === 'getProjectEffectiveness')?.[1]).toMatchObject({ path: { id: PROJECT } });
  });

  it('shows the set that stands fixed: basis, who drafted and who fixed it, the fixed day and one row per indicator with every figure, its day, its method and its band in words', async () => {
    show(open({ getProjectEffectiveness: view() }));
    const served = await rowOf('tr[data-indicator="SERVED"]');
    const fixed = screen.getByTestId('fixed-set');
    expect(fixed.textContent).toContain('Decision 12 approving the project');
    expect(fixed.textContent).toContain(text('ui.makerChecker.maker', { name: 'Nguyễn Văn An' }));
    expect(fixed.textContent).toContain(text('ui.makerChecker.checker', { name: 'Trần Thị Bình' }));
    expect(fixed.textContent).toContain('02/02/2026');
    expect(fixed.textContent).toContain(text('mr1.effect.fixed.version'));
    expect(served.textContent).toContain('Indicator SERVED');
    expect(served.textContent).toContain(text('mr1.effect.direction.higher'));
    expect(served.textContent).toContain(text('mr1.effect.valueUnit', { value: '40', unit: '%' }));
    expect(served.textContent).toContain('01/01/2026');
    expect(served.textContent).toContain(text('mr1.effect.valueUnit', { value: '80', unit: '%' }));
    expect(served.textContent).toContain(text('mr1.effect.valueUnit', { value: '60', unit: '%' }));
    expect(served.textContent).toContain(text('mr1.effect.actual.on', { day: '01/03/2027' }));
    expect(served.textContent).toContain('Household survey');
    expect(served.textContent).toContain(text('mr1.effect.valueUnit', { value: '-20', unit: '%' }));
    expect(served.textContent).toContain(text('mr1.effect.pct', { value: '-25.00' }));
    expect(served.textContent).toContain(text('mr1.effect.pct', { value: '50.00' }));
    expect(served.textContent).toContain(text('mr1.effect.band.missed'));
    expect(served.getAttribute('data-band')).toBe('MISSED');
    expect((await rowOf('tr[data-indicator="WATER"]')).textContent).toContain(text('mr1.effect.band.met'));
    expect(screen.getByTestId('band-rule').textContent).toBe(text('mr1.effect.band.rule', { met: 100, partly: 70 }));
    expect(screen.getByText(text('mr1.effect.superseded.line', { version: 1, day: '10/01/2026' }))).toBeTruthy();
  });

  it('puts an "i" on the target, the actual, the variance, the achievement and the band, and opens it on the formula, the source, the day and the version', async () => {
    show(open({ getProjectEffectiveness: view() }));
    const served = await rowOf('tr[data-indicator="SERVED"]');
    expect(infoButtons(served).length).toBe(5);
    const [target, , variance] = infoButtons(served);
    fireEvent.click(target as HTMLElement);
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('Share of households served');
    expect(panel.textContent).toContain('Household survey');
    fireEvent.click(within(panel).getByRole('button', { name: text('mr1.info.close') }));
    fireEvent.click(variance as HTMLElement);
    const rule = screen.getByRole('dialog');
    expect(rule.textContent).toContain('Achievement runs from the baseline to the target');
    expect(rule.textContent).toContain('Governance rule registry');
    expect(rule.textContent).toContain('08/11/2026');
    expect(rule.textContent).toContain('built-in:1');
    expect(rule.textContent).toContain(text('mr1.info.unverified'));
  });

  it('shows an indicator that is not measured as "not measured" with the reason, never as zero', async () => {
    show(open({ getProjectEffectiveness: view() }));
    const power = await rowOf('tr[data-indicator="POWER"]');
    expect(power.getAttribute('data-band')).toBe('NOT_MEASURED');
    expect(power.textContent).toContain(text('mr1.effect.actual.none'));
    expect(power.textContent).toContain(text('mr1.effect.band.notMeasured'));
    expect(power.textContent).toContain(text('mr1.effect.na.known', { reason: text('mr1.effect.na.noMeasurement') }));
    expect(power.textContent).not.toContain(text('mr1.effect.pct', { value: '0' }));
    expect(power.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('says the thresholds of the band are a default that is not confirmed, and that the evaluation calendar rule is not verified against the law', async () => {
    show(open({ getProjectEffectiveness: view({ calendar: [calendarEntry('FINAL')] }) }));
    expect((await screen.findByTestId('policy-unverified')).textContent).toBe(text('mr1.effect.policy.unverified'));
    const notice = screen.getByTestId('calendar-unverified');
    expect(notice.textContent).toBe(text('mr1.effect.calendar.unverified'));
    expect(notice.getAttribute('role')).toBe('status');
    cleanup();
    show(open({ getProjectEffectiveness: view({ policy: policy({ unverified: false }), calendar: [calendarEntry('FINAL', { rule_unverified: false })] }) }));
    await rowOf('tr[data-indicator="SERVED"]');
    expect(screen.queryByTestId('policy-unverified')).toBeNull();
    expect(screen.queryByTestId('calendar-unverified')).toBeNull();
  });

  it('shows the measurement history newest first with the corrected rows marked and the corrections named', async () => {
    const measurements = [
      { id: uuid(701), indicator_code: 'SERVED', measured_on: '2027-01-01', value: '50', method_note: 'First survey', evidence_document_id: null, corrects_id: null, correction_reason: null, corrected: true, recorded_by: person(3, 'Lê Văn Cường'), recorded_at: '2027-01-02T01:00:00.000Z' },
      { id: uuid(702), indicator_code: 'SERVED', measured_on: '2027-03-01', value: '60', method_note: 'Second survey', evidence_document_id: uuid(9), corrects_id: uuid(701), correction_reason: 'The first reading was a typo', corrected: false, recorded_by: person(3, 'Lê Văn Cường'), recorded_at: '2027-03-02T01:00:00.000Z' },
    ];
    show(open({ getProjectEffectiveness: view({ measurements }) }));
    await rowOf('tr[data-measurement]');
    const rows = Array.from(document.querySelectorAll('tr[data-measurement]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-corrected')).toBe('no');
    expect(rows[0]?.textContent).toContain(text('mr1.effect.measurement.corrects'));
    expect(rows[0]?.textContent).toContain('The first reading was a typo');
    expect(rows[0]?.textContent).toContain('Lê Văn Cường');
    expect(rows[1]?.getAttribute('data-corrected')).toBe('yes');
    expect(rows[1]?.textContent).toContain(text('mr1.effect.measurement.corrected'));
    // A row that is already corrected offers no second correction.
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: text('mr1.effect.action.correct') })).toBeNull();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: text('mr1.effect.action.correct') })).toBeTruthy();
  });

  it('shows the calendar with the state in words and a sign, the days late, the anchor and the due day', async () => {
    const calendar = [calendarEntry('FINAL', { state: 'OVERDUE', days_late: 12, due_on: '2027-04-01' }), calendarEntry('INITIAL', { state: 'DONE', status: 'DONE', due_on: '2026-12-01' }), calendarEntry('MIDTERM', { state: 'DUE_SOON', due_on: '2027-06-01' }), calendarEntry('IMPACT', { state: 'UPCOMING', due_on: '2028-01-01', required: false })];
    show(open({ getProjectEffectiveness: view({ calendar }) }));
    await rowOf('tr[data-kind="FINAL"]');
    const states = Array.from(document.querySelectorAll('tr[data-kind]')).map((row) => [row.getAttribute('data-kind'), row.getAttribute('data-state')]);
    expect(states.map(([kind]) => kind)).toEqual(['INITIAL', 'FINAL', 'MIDTERM', 'IMPACT']);
    expect((await rowOf('tr[data-kind="FINAL"]')).textContent).toContain(text('mr1.effect.state.overdue', { days: 12 }));
    expect((await rowOf('tr[data-kind="FINAL"]')).textContent).toContain(text('mr1.effect.calendar.anchorOn', { anchor: text('mr1.effect.anchor.completion'), day: '01/01/2027' }));
    expect((await rowOf('tr[data-kind="FINAL"]')).textContent).toContain('01/04/2027');
    expect((await rowOf('tr[data-kind="INITIAL"]')).textContent).toContain(text('mr1.effect.state.done'));
    expect((await rowOf('tr[data-kind="MIDTERM"]')).textContent).toContain(text('mr1.effect.state.dueSoon'));
    expect((await rowOf('tr[data-kind="IMPACT"]')).textContent).toContain(text('mr1.effect.state.upcoming'));
    expect((await rowOf('tr[data-kind="IMPACT"]')).textContent).toContain(text('mr1.effect.calendar.optional'));
  });

  it('shows each assessment with its conclusion, summary, status, who submitted and who decided, the reason and the frozen figures', async () => {
    const assessments = [assessmentRow(), assessmentRow({ id: uuid(201), status: 'APPROVED', conclusion: 'SATISFACTORY', decided_by: person(2, 'Trần Thị Bình'), decided_at: '2027-04-05T01:00:00.000Z', decision_reason: 'Figures match', version: 10 })];
    show(open({ getProjectEffectiveness: view({ assessments, can: CAN_NONE }) }));
    const submitted = await rowOf(`tr[data-assessment="${ASSESSMENT}"]`);
    expect(submitted.textContent).toContain(text('mr1.effect.kind.final'));
    expect(submitted.textContent).toContain(text('mr1.effect.conclusion.partially'));
    expect(submitted.textContent).toContain('Two of three targets are within reach');
    expect(submitted.textContent).toContain(text('mr1.effect.assessment.status.submitted'));
    expect(submitted.textContent).toContain(text('ui.makerChecker.maker', { name: 'Nguyễn Văn An' }));
    expect(submitted.textContent).toContain(text('ui.makerChecker.pending'));
    expect(submitted.textContent).toContain(text('mr1.effect.assessment.lines', { count: 1 }));
    expect(submitted.textContent).toContain(text('mr1.effect.band.missed'));
    expect(infoButtons(submitted).length).toBeGreaterThanOrEqual(1);
    const approved = await rowOf(`tr[data-assessment="${uuid(201)}"]`);
    expect(approved.textContent).toContain(text('mr1.effect.assessment.status.approved'));
    expect(approved.textContent).toContain(text('ui.makerChecker.checker', { name: 'Trần Thị Bình' }));
    expect(approved.textContent).toContain('Figures match');
    expect(approved.textContent).toContain(text('mr1.effect.assessment.decidedOn', { day: '05/04/2027' }));
  });

  it('says in words that there is no fixed set, no history, no calendar and no assessment yet', async () => {
    show(open({ getProjectEffectiveness: view({ fixed: null, superseded: [], can: CAN_NONE }) }));
    expect((await screen.findByTestId('no-fixed')).textContent).toBe(text('mr1.effect.fixed.none'));
    expect(screen.getAllByText('Chưa có dữ liệu').length).toBeGreaterThanOrEqual(3);
  });

  it('shows a skeleton and not a single zero while it loads', () => {
    show(open({ getProjectEffectiveness: new Promise(() => undefined) }));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('fixed-set')).toBeNull();
    expect(screen.queryByTestId('actions')).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('says it could not load and reads again on retry', async () => {
    let calls = 0;
    show(
      open({
        getProjectEffectiveness: () => {
          calls += 1;
          return calls === 1 ? new Error('down') : view();
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Thử lại/ }));
    expect(await screen.findByTestId('fixed-set')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('says in words that the project is not there for the caller (404) and that a refused read is hidden (403)', async () => {
    show(open({ getProjectEffectiveness: refusal('RESOURCE_NOT_FOUND', 404) }));
    expect((await screen.findByTestId('project-missing')).textContent).toBe(text('mr1.effect.project.missing'));
    cleanup();
    show(open({ getProjectEffectiveness: refusal('SCOPE_DENIED', 403) }));
    expect((await screen.findByRole('alert')).textContent).toContain('Bạn chưa có quyền truy cập');
  });
});

describe('EffectivenessScreen (MNE-11): who may act', () => {
  it('offers no action to a reader and says so in words', async () => {
    show(open({ getProjectEffectiveness: view({ can: CAN_NONE, draft: targetSet('DRAFT') }) }));
    expect((await screen.findByTestId('read-only')).textContent).toBe(text('mr1.effect.readonly.notice'));
    expect(screen.queryByTestId('actions')).toBeNull();
    for (const name of ['draft', 'measure', 'calendar', 'assess', 'fix', 'approve', 'return', 'correct']) expect(action(name)).toBeNull();
  });

  it('offers no action to a read-only session even when the server says the caller may', async () => {
    const assessments = [assessmentRow()];
    const measurements = [{ id: uuid(701), indicator_code: 'SERVED', measured_on: '2027-01-01', value: '50', method_note: 'x', recorded_at: '2027-01-02T01:00:00.000Z' }];
    show(open({ getProjectEffectiveness: view({ draft: targetSet('DRAFT', { id: uuid(101) }), assessments, measurements }) }), { mode: 'READ_ONLY' });
    expect(await screen.findByTestId('read-only')).toBeTruthy();
    for (const name of ['draft', 'measure', 'calendar', 'assess', 'approve', 'return', 'correct']) expect(action(name)).toBeNull();
    // The fix button belongs to the draft; a session that cannot write has none either.
    expect(screen.getByTestId('draft-set')).toBeTruthy();
  });

  it('shows only the buttons the flags of the server allow', async () => {
    show(open({ getProjectEffectiveness: view({ can: { ...CAN_NONE, measure: true, assess: true } }) }));
    await screen.findByTestId('actions');
    expect(action('measure')).not.toBeNull();
    expect(action('assess')).not.toBeNull();
    expect(action('draft')).toBeNull();
    expect(action('calendar')).toBeNull();
  });
});

describe('EffectivenessScreen (MNE-11): drafting and fixing', () => {
  it('drafts a new set in a dialog with a repeating list of indicators, sends only what was written and says it is saved', async () => {
    const h = open({ getProjectEffectiveness: view({ fixed: null, superseded: [], can: { ...CAN_NONE, draft: true } }) }, () => OK);
    show(h);
    fireEvent.click((await buttonOf('draft')));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(new RegExp(text('mr1.effect.form.supersedeReason')))).toBeNull();
    type(field(dialog, 'draft-basis'), 'Feasibility study approved');
    type(field(dialog, 'draft-0-code'), 'SERVED');
    type(field(dialog, 'draft-0-name'), 'Households served');
    type(field(dialog, 'draft-0-unit'), '%');
    type(field(dialog, 'draft-0-baseline'), '40,5');
    type(field(dialog, 'draft-0-target'), '80');
    type(field(dialog, 'draft-0-source'), 'Household survey');
    type(field(dialog, 'draft-0-formula'), 'Served divided by all');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.form.add') }));
    expect(dialog.querySelectorAll('[data-indicator-row]')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.form.remove', { row: 2 }) }));
    expect(dialog.querySelectorAll('[data-indicator-row]')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.draft.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('saveEffectTargetDraft');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: { basis: 'Feasibility study approved', indicators: [{ code: 'SERVED', name: 'Households served', unit: '%', direction: 'HIGHER_IS_BETTER', baseline_value: '40.5', target_value: '80', data_source: 'Household survey', formula: 'Served divided by all' }] } });
    expect(sent(h, 'saveEffectTargetDraft')[0]?.body).not.toHaveProperty('supersede_reason');
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.draft.done'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks the reason of a revision when a fixed set stands, copies the indicators, and sends the reason', async () => {
    const h = open({ getProjectEffectiveness: view({ superseded: [] }) });
    show(h);
    fireEvent.click((await buttonOf('draft')));
    const dialog = screen.getByRole('dialog');
    expect(field(dialog, 'draft-0-code').value).toBe('SERVED');
    expect(field(dialog, 'draft-1-code').value).toBe('POWER');
    const confirm = within(dialog).getByRole('button', { name: text('mr1.effect.draft.confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    type(within(dialog).getByLabelText(new RegExp(text('mr1.effect.form.supersedeReason'))), 'The scope of the works changed');
    type(field(dialog, 'draft-0-target'), '85');
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const body = sent(h, 'saveEffectTargetDraft')[0]?.body as { supersede_reason: string; indicators: Array<{ code: string; target_value: string }> };
    expect(body.supersede_reason).toBe('The scope of the works changed');
    expect(body.indicators).toHaveLength(3);
    expect(body.indicators[0]).toMatchObject({ code: 'SERVED', target_value: '85' });
  });

  it('names the field that is wrong, in the dialog, and sends nothing', async () => {
    const h = open({ getProjectEffectiveness: view({ fixed: null, superseded: [], can: { ...CAN_NONE, draft: true } }) });
    show(h);
    fireEvent.click((await buttonOf('draft')));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.draft.confirm') }));
    expect(dialogError()).toBe(text('mr1.effect.validation.field', { field: text('mr1.effect.form.basis') }));
    expect(within(dialog).getAllByRole('alert').some((alert) => alert.textContent === text('mr1.effect.problem.required'))).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
    type(field(dialog, 'draft-basis'), 'Feasibility study approved');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.draft.confirm') }));
    expect(dialogError()).toBe(text('mr1.effect.validation.field', { field: text('mr1.effect.form.rowField', { row: 1, field: text('mr1.effect.form.code') }) }));
  });

  it.each([
    ['PROJECT_STAGE_INVALID', 422, {}, undefined, text('mr1.effect.refusal.stageInvalid')],
    ['VALIDATION_FAILED', 422, {}, 'indicators', text('mr1.effect.refusal.validationField', { field: text('mr1.effect.field.indicators') })],
    ['EFFECT_TARGET_STATE_INVALID', 409, { reason: 'NOT_THE_AUTHOR' }, undefined, text('mr1.effect.refusal.notTheAuthor')],
    ['SCOPE_DENIED', 403, {}, undefined, text('mr1.effect.refusal.denied')],
    ['VERSION_CONFLICT', 409, {}, undefined, text('mr1.effect.refusal.versionConflict')],
  ])('says the refusal %s of a draft inside the dialog and keeps it open', async (code, status, extensions, detail, expected) => {
    const h = open({ getProjectEffectiveness: view({ superseded: [] }) }, () => refusal(code, status, extensions, detail));
    show(h);
    fireEvent.click((await buttonOf('draft')));
    const dialog = screen.getByRole('dialog');
    type(within(dialog).getByLabelText(new RegExp(text('mr1.effect.form.supersedeReason'))), 'The scope of the works changed');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.draft.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(expected));
    expect(screen.queryByTestId('message')).toBeNull();
  });

  it('shows the draft with nobody who checked it, the rule that its fixer is not its drafter, and a fix button only when the flag says so', async () => {
    show(open({ getProjectEffectiveness: view({ draft: targetSet('DRAFT', { id: uuid(101) }), can: { ...CAN_NONE, fix: true } }) }));
    const draft = await screen.findByTestId('draft-set');
    expect(draft.textContent).toContain(text('ui.makerChecker.maker', { name: 'Nguyễn Văn An' }));
    expect(draft.textContent).toContain(text('ui.makerChecker.pending'));
    expect(screen.getByTestId('draft-fix-rule').textContent).toBe(text('mr1.effect.fix.rule'));
    expect(action('fix')).not.toBeNull();
    cleanup();
    show(open({ getProjectEffectiveness: view({ draft: targetSet('DRAFT', { id: uuid(101) }), can: CAN_NONE }) }));
    await screen.findByTestId('draft-set');
    expect(action('fix')).toBeNull();
    expect(screen.getByTestId('draft-fix-rule')).toBeTruthy();
  });

  it('fixes the draft under the version it saw, with no body, after naming the effect and the rule', async () => {
    const h = open({ getProjectEffectiveness: view({ draft: targetSet('DRAFT', { id: uuid(101) }), can: { ...CAN_NONE, fix: true } }) });
    show(h);
    fireEvent.click((await buttonOf('fix')));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('fix-rule').textContent).toBe(text('mr1.effect.fix.rule'));
    expect(dialog.textContent).toContain('Nguyễn Văn An');
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.fix.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('fixEffectTargets');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(101) }, ifMatchVersion: 7 });
    expect(h.command.mock.calls[0]?.[1]).not.toHaveProperty('body');
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.fix.done'));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'mr1.effect.refusal.selfApproval'],
    ['EFFECT_TARGET_STATE_INVALID', 409, 'mr1.effect.refusal.targetState'],
    ['VERSION_CONFLICT', 409, 'mr1.effect.refusal.versionConflict'],
    ['PROJECT_STAGE_INVALID', 422, 'mr1.effect.refusal.stageInvalid'],
  ])('says the refusal %s of a fix inside the dialog', async (code, status, key) => {
    const h = open({ getProjectEffectiveness: view({ draft: targetSet('DRAFT', { id: uuid(101) }), can: { ...CAN_NONE, fix: true } }) }, () => refusal(code, status));
    show(h);
    fireEvent.click((await buttonOf('fix')));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('mr1.effect.fix.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(text(key)));
    expect(screen.queryByTestId('message')).toBeNull();
  });
});

describe('EffectivenessScreen (MNE-11): measurements', () => {
  const fill = (dialog: HTMLElement): void => {
    type(field(dialog, 'measure-on'), '2026-10-15');
    type(field(dialog, 'measure-value'), '61,5');
    type(field(dialog, 'measure-method'), 'Field survey of 400 households');
  };

  it('records an actual value for an indicator of the fixed set, the decimal as a text, and says it is recorded', async () => {
    const h = open({ getProjectEffectiveness: view() });
    show(h);
    fireEvent.click((await buttonOf('measure')));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).toEqual(expect.arrayContaining(['SERVED · Indicator SERVED', 'POWER · Indicator POWER']));
    type(field(dialog, 'measure-indicator'), 'POWER');
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('recordEffectMeasurement');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: { indicator_code: 'POWER', measured_on: '2026-10-15', value: '61.5', method_note: 'Field survey of 400 households' } });
    expect(sent(h, 'recordEffectMeasurement')[0]?.body).not.toHaveProperty('corrects_id');
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.measure.done'));
  });

  it('names the field that is wrong and sends nothing', async () => {
    const h = open({ getProjectEffectiveness: view() });
    show(h);
    fireEvent.click((await buttonOf('measure')));
    const dialog = screen.getByRole('dialog');
    type(field(dialog, 'measure-on'), '2026-10-15');
    type(field(dialog, 'measure-value'), 'abc');
    type(field(dialog, 'measure-method'), 'Field survey');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    expect(dialogError()).toBe(text('mr1.effect.validation.field', { field: text('mr1.effect.form.value') }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('corrects a row with a reason: the dialog opens on its indicator, names the row corrected, and the old row stays', async () => {
    const measurements = [{ id: uuid(701), indicator_code: 'SERVED', measured_on: '2027-01-01', value: '50', method_note: 'First survey', evidence_document_id: null, corrects_id: null, correction_reason: null, corrected: false, recorded_by: person(3, 'Lê Văn Cường'), recorded_at: '2027-01-02T01:00:00.000Z' }];
    const h = open({ getProjectEffectiveness: view({ measurements }) });
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: text('mr1.effect.action.correct') }));
    const dialog = screen.getByRole('dialog', { name: text('mr1.effect.measure.titleCorrection') });
    expect(field(dialog, 'measure-indicator').value).toBe('SERVED');
    expect(field(dialog, 'measure-indicator').disabled).toBe(true);
    expect(field(dialog, 'measure-corrects').value).toBe(uuid(701));
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    expect(dialogError()).toBe(text('mr1.effect.validation.field', { field: text('mr1.effect.form.correctionReason') }));
    type(field(dialog, 'measure-reason'), 'The first reading was a typo');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { indicator_code: 'SERVED', corrects_id: uuid(701), correction_reason: 'The first reading was a typo', value: '61.5' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.measure.doneCorrection'));
  });

  it.each([
    ['EFFECT_MEASUREMENT_DUPLICATE', 409, 'mr1.effect.refusal.measurementDuplicate'],
    ['EFFECT_TARGETS_NOT_FIXED', 409, 'mr1.effect.refusal.notFixed'],
    ['PROJECT_STAGE_INVALID', 422, 'mr1.effect.refusal.stageInvalid'],
    ['SCOPE_DENIED', 403, 'mr1.effect.refusal.denied'],
  ])('says the refusal %s of a measurement inside the dialog', async (code, status, key) => {
    const h = open({ getProjectEffectiveness: view() }, () => refusal(code, status));
    show(h);
    fireEvent.click((await buttonOf('measure')));
    const dialog = screen.getByRole('dialog');
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(text(key)));
  });

  it('names the field the server found wrong (422) in the dialog', async () => {
    const h = open({ getProjectEffectiveness: view() }, () => refusal('VALIDATION_FAILED', 422, {}, 'indicator_code'));
    show(h);
    fireEvent.click((await buttonOf('measure')));
    const dialog = screen.getByRole('dialog');
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.measure.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(text('mr1.effect.refusal.validationField', { field: text('mr1.effect.field.indicatorCode') })));
  });
});

describe('EffectivenessScreen (MNE-11): the calendar', () => {
  it('generates the calendar after a confirmation, with no body, and says which entries were made and which wait for an anchor day', async () => {
    const answer = { ...OK, created: [{ id: uuid(1), kind: 'INITIAL', due_on: '2027-03-01', anchor: 'IMPLEMENTATION_START', anchor_on: '2026-03-01' }], waiting: [{ kind: 'FINAL', anchor: 'COMPLETION' }], rule: { code: 'GROUP_B', version: 'built-in:1', unverified: true } };
    const h = open({ getProjectEffectiveness: view() }, () => answer);
    show(h);
    fireEvent.click((await buttonOf('calendar')));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('calendar-dialog-notice').textContent).toBe(text('mr1.effect.calendar.unverified'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.calendar.generate.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('generateEffectCalendar');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT } });
    expect(h.command.mock.calls[0]?.[1]).not.toHaveProperty('body');
    const result = await screen.findByTestId('calendar-result');
    expect(result.textContent).toContain(text('mr1.effect.calendar.result.created', { kind: text('mr1.effect.kind.initial'), due: '01/03/2027' }));
    expect(result.textContent).toContain(text('mr1.effect.calendar.result.waiting', { kind: text('mr1.effect.kind.final'), anchor: text('mr1.effect.anchor.completion') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.calendar.generate.done'));
  });

  it('says that nothing was new when every entry was made before', async () => {
    const h = open({ getProjectEffectiveness: view() }, () => ({ ...OK, created: [], waiting: [], rule: { unverified: false } }));
    show(h);
    fireEvent.click((await buttonOf('calendar')));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('mr1.effect.calendar.generate.confirm') }));
    expect((await screen.findByTestId('calendar-result')).textContent).toContain(text('mr1.effect.calendar.result.nothing'));
  });

  it('says a refusal of the generation inside the dialog', async () => {
    const h = open({ getProjectEffectiveness: view() }, () => refusal('VALIDATION_FAILED', 422, {}, 'project_group'));
    show(h);
    fireEvent.click((await buttonOf('calendar')));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('mr1.effect.calendar.generate.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(text('mr1.effect.refusal.validationField', { field: text('mr1.effect.field.projectGroup') })));
  });
});

describe('EffectivenessScreen (MNE-11): assessments', () => {
  it('submits an assessment with the conclusion the figures suggest already chosen, and says it is submitted', async () => {
    const h = open({ getProjectEffectiveness: view({ calendar: [calendarEntry('FINAL')], suggested_conclusion: 'UNSATISFACTORY' }) });
    show(h);
    fireEvent.click((await buttonOf('assess')));
    const dialog = screen.getByRole('dialog');
    expect(field(dialog, 'assess-conclusion').value).toBe('UNSATISFACTORY');
    expect(field(dialog, 'assess-kind').value).toBe('FINAL');
    expect(dialog.textContent).toContain(text('mr1.effect.form.conclusion.suggested', { conclusion: text('mr1.effect.conclusion.unsatisfactory') }));
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.assess.confirm') }));
    expect(dialogError()).toBe(text('mr1.effect.validation.field', { field: text('mr1.effect.form.summary') }));
    expect(h.command).not.toHaveBeenCalled();
    type(field(dialog, 'assess-summary'), 'Only one target is within reach');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.assess.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('submitEffectAssessment');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: { kind: 'FINAL', conclusion: 'UNSATISFACTORY', summary: 'Only one target is within reach' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.assess.done'));
  });

  it.each([
    ['VALIDATION_FAILED', 422, { reason: 'NO_MEASUREMENT' }, 'mr1.effect.refusal.noMeasurement'],
    ['EFFECT_ASSESSMENT_STATE_INVALID', 409, { reason: 'ALREADY_APPROVED' }, 'mr1.effect.refusal.assessmentAlready'],
    ['EFFECT_ASSESSMENT_STATE_INVALID', 409, {}, 'mr1.effect.refusal.assessmentState'],
    ['EFFECT_TARGETS_NOT_FIXED', 409, {}, 'mr1.effect.refusal.notFixed'],
    ['PROJECT_STAGE_INVALID', 422, {}, 'mr1.effect.refusal.stageInvalid'],
  ])('says the refusal %s %j of a submission inside the dialog', async (code, status, extensions, key) => {
    const h = open({ getProjectEffectiveness: view() }, () => refusal(code, status, extensions));
    show(h);
    fireEvent.click((await buttonOf('assess')));
    const dialog = screen.getByRole('dialog');
    type(field(dialog, 'assess-summary'), 'Only one target is within reach');
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.assess.confirm') }));
    await waitFor(() => expect(dialogError()).toBe(text(key)));
  });

  it('approves an assessment under the version it saw, the person who submitted shown as maker, and says it is approved', async () => {
    const h = open({ getProjectEffectiveness: view({ assessments: [assessmentRow()], can: { ...CAN_NONE, decide: true } }) });
    show(h);
    fireEvent.click((await buttonOf('approve')));
    const dialog = screen.getByRole('dialog', { name: text('mr1.effect.decide.approveTitle') });
    expect(dialog.textContent).toContain(text('ui.makerChecker.maker', { name: 'Nguyễn Văn An' }));
    expect(within(dialog).getByTestId('decide-rule').textContent).toBe(text('mr1.effect.decide.rule'));
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.effect.decide.approve') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('decideEffectAssessment');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ASSESSMENT }, ifMatchVersion: 9, body: { decision: 'APPROVE' } });
    expect(sent(h, 'decideEffectAssessment')[0]?.body).not.toHaveProperty('reason');
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.decide.doneApprove'));
  });

  it('returns an assessment only with a reason of at least ten characters', async () => {
    const h = open({ getProjectEffectiveness: view({ assessments: [assessmentRow()], can: { ...CAN_NONE, decide: true } }) });
    show(h);
    fireEvent.click((await buttonOf('return')));
    const dialog = screen.getByRole('dialog', { name: text('mr1.effect.decide.returnTitle') });
    const confirm = within(dialog).getByRole('button', { name: text('mr1.effect.decide.return') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'too short' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The summary does not match the figures' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ASSESSMENT }, ifMatchVersion: 9, body: { decision: 'RETURN', reason: 'The summary does not match the figures' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.effect.decide.doneReturn'));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'mr1.effect.refusal.selfApproval'],
    ['EFFECT_ASSESSMENT_STATE_INVALID', 409, 'mr1.effect.refusal.assessmentState'],
    ['VERSION_CONFLICT', 409, 'mr1.effect.refusal.versionConflict'],
  ])('says the refusal %s of a decision inside the dialog', async (code, status, key) => {
    const h = open({ getProjectEffectiveness: view({ assessments: [assessmentRow()], can: { ...CAN_NONE, decide: true } }) }, () => refusal(code, status));
    show(h);
    fireEvent.click((await buttonOf('approve')));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('mr1.effect.decide.approve') }));
    await waitFor(() => expect(dialogError()).toBe(text(key)));
    expect(screen.queryByTestId('message')).toBeNull();
  });

  it('offers a decision only on an assessment that waits for one', async () => {
    show(open({ getProjectEffectiveness: view({ assessments: [assessmentRow({ status: 'APPROVED', decided_by: person(2, 'Trần Thị Bình'), decided_at: '2027-04-05T01:00:00.000Z' })], can: { ...CAN_NONE, decide: true } }) }));
    await rowOf(`tr[data-assessment="${ASSESSMENT}"]`);
    expect(action('approve')).toBeNull();
    expect(action('return')).toBeNull();
  });
});

describe('MNE-11 sources', () => {
  it('use no raw colour: every colour is a token', () => {
    const folder = __dirname;
    for (const name of readdirSync(folder).filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\./.test(file))) {
      const source = readFileSync(join(folder, name), 'utf8');
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, name).not.toMatch(/\brgba?\(/);
    }
  });
});
