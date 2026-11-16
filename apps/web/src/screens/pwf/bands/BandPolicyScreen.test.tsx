import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { ALL_PERMISSIONS, OTHER, READ_ONLY, refusal, routeOf, serve, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { mountAs } from '../templates/test/mount';
import { templateCatalogue, templateEffective } from '../templates/test/fixtures';
import { templateParams } from '../test/fixtures';
import BandPolicyScreen from './BandPolicyScreen';
import { POLICY, bandEffective, bandPreview, bandVersion, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-08');

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  preview?: Answer;
  versions?: unknown[];
  commands?: Record<string, Answer>;
  /** The effective template of each code of the library, when a test needs steps with thresholds of their own. */
  templates?: Record<string, unknown>;
}

const TEMPLATE_TYPE = 'PROJECT_WORKFLOW_TEMPLATE';
const isTemplateRead = (input: Record<string, unknown>): boolean => (input.query as { rule_type?: string } | undefined)?.rule_type === TEMPLATE_TYPE;

/** The tasks of the default template, the first one carrying thresholds of its own. */
const withOwnBands = (name: string) => {
  const base = templateParams({ name }).tasks;
  return templateParams({ name, tasks: [{ ...(base[0] as object), bands: { green_days: 6, yellow_days: 3, red_days: 1 } } as never, ...base.slice(1)] });
};

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getGovernanceRuleCatalog: templateCatalogue(),
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => {
        const code = (input.query as { code: string }).code;
        if (isTemplateRead(input)) return setup.templates?.[code] ?? templateEffective({ code });
        return typeof setup.effective === 'function' ? setup.effective(input) : (setup.effective ?? bandEffective(code));
      },
      listGovernanceRuleVersions: (input: Record<string, unknown>) => ({ items: isTemplateRead(input) ? [] : (setup.versions ?? [bandVersion(1)]) }),
      previewDeadlineBand: setup.preview ?? bandPreview(),
    },
    { createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 }, ...setup.commands },
  );
  mountAs(<BandPolicyScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-08' });
  return h;
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });
const ready = async () => screen.findByTestId('sentence');
const previewCalls = (h: ReturnType<typeof open>) => h.read.mock.calls.filter((call) => call[0] === 'previewDeadlineBand').map((call) => (call[1] as { query: Record<string, unknown> }).query);

describe('PWF-08: reading the policy', () => {
  it('opens the policy of the task source with the three numbers, the unit and the rule in force', async () => {
    open();
    await ready();
    expect(field('green_days').value).toBe('5');
    expect(field('yellow_days').value).toBe('2');
    expect(field('red_days').value).toBe('0');
    expect(screen.getByTestId('unit-declared').textContent).toContain('ngày làm việc');
    expect(field('reminder_days').value).toBe('5, 2, 0, -1');
    expect(field('escalate_after_overdue_days').value).toBe('3');
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.bands.base.rule', { version: 1 }));
    expect((screen.getByTestId('source') as HTMLSelectElement).value).toBe('PROJECT_TASK');
  });

  it('says the ladder as the owner does, and says the unit once for the whole table', async () => {
    open();
    expect((await ready()).textContent).toBe('Còn 5 ngày: xanh, còn 2 ngày: vàng, hôm hạn: đỏ');
    expect(screen.getByTestId('unit-declared').textContent).toBe(text('wfxbands.unit.declared.text', { unit: 'ngày làm việc' }));
    // The unit is the one of the source and is no choice: there is no unit box.
    expect(screen.queryByTestId('field-unit')).toBeNull();
    expect(screen.getAllByText(/ngày làm việc/).length).toBeGreaterThan(0);
  });

  it('keeps the table short: a default row, then one row for each exception, with red, yellow and green on every row and a label on every box', async () => {
    open();
    await ready();
    const table = screen.getByTestId('ladder-table');
    expect([...table.querySelectorAll('thead th')].slice(0, 4).map((head) => head.textContent?.trim().split(' ')[0])).toEqual([text('wfxbands.col.scope.label').split(' ')[0], text('wfxbands.col.red.label'), text('wfxbands.col.yellow.label'), text('wfxbands.col.green.label')]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-action="add-override"]') as HTMLElement);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByLabelText(text('wfxbands.cell.red.label', { row: text('wfxbands.row.default.name') }))).toBe(field('red_days'));
    expect(screen.getByLabelText(text('wfxbands.cell.green.label', { row: text('wfxbands.row.exception.name', { number: 1 }) }))).toBe(field('overrides[0].green_days'));
    // The wide table scrolls inside its own region, never the page.
    expect(table.closest('.ui-table-scroll')).not.toBeNull();
  });

  it('shows what the server says each number of days left turns into, with the word and the glyph and the unit', async () => {
    const h = open();
    const list = await screen.findByTestId('examples');
    expect(previewCalls(h)[0]).toEqual({ yellow_days: 2, red_days: 0, green_days: 5, unit: 'WORKING' });
    const rows = [...list.querySelectorAll('li')];
    expect(rows).toHaveLength(5);
    expect(within(rows[1] as HTMLElement).getByText(text('pwf.band.green.word'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('✓')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(text('pwf.band.remaining.text', { days: 5, unit: text('pwf.unit.working.word') }))).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText(text('pwf.band.overdue.text', { days: 1, unit: text('pwf.unit.working.word') }))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(text('pwf.band.none.word'))).toBeTruthy();
    // The thresholds the server applies carry the "i".
    fireEvent.click(within(screen.getByTestId('preview')).getByRole('button', { name: /.+/ }));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.bands.preview.formula'));
  });

  it('starts from the default of the system when no rule of the tenant is in force, and from blank when nothing governs the source', async () => {
    open({ path: '/pwf/pwf-08?code=HOME_WORK', effective: bandEffective('HOME_WORK', { source: 'DEFAULT', version: 0, rule_id: null, unverified: true, params: { ...POLICY, unit: 'CALENDAR', green_days: 7, yellow_days: 3, red_days: -1 } }) });
    await ready();
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.bands.base.default'));
    expect(screen.getAllByText(text('pwf.common.unverified.label')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
    expect(field('red_days').value).toBe('-1');
    expect((await screen.findByTestId('sentence')).textContent).toBe('Còn 7 ngày: xanh, còn 3 ngày: vàng, quá hạn: đỏ');
    // A source counted in calendar days says so once.
    expect(screen.getByTestId('unit-declared').textContent).toBe(text('wfxbands.unit.declared.text', { unit: 'ngày' }));
    cleanup();
    open({ effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    await screen.findByTestId('preview-blocked');
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.bands.base.blank'));
    expect(field('green_days').value).toBe('');
  });

  it('reads the policy of another source when it is chosen', async () => {
    const h = open();
    await ready();
    fireEvent.change(screen.getByTestId('source'), { target: { value: 'REPORT_SCHEDULE' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => call[0] === 'getEffectiveGovernanceRule' && (call[1] as { query: { code: string } }).query.code === 'REPORT_SCHEDULE')).toBe(true));
    expect((screen.getByTestId('source') as HTMLSelectElement).value).toBe('REPORT_SCHEDULE');
  });

  it('is denied without the permission to read and reads nothing', () => {
    const h = open({ permissions: [] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the policy but changes nothing when the session is read-only or the person cannot write rules', async () => {
    open({ mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    expect(field('green_days').disabled).toBe(true);
    expect(screen.queryByTestId('save')).toBeNull();
    cleanup();
    open({ permissions: READ_ONLY });
    await ready();
    expect(screen.queryByTestId('save')).toBeNull();
  });
});

describe('PWF-08: editing the numbers', () => {
  it('asks the server again when a number changes, and says the new ladder', async () => {
    const h = open();
    await ready();
    change('yellow_days', '3');
    await waitFor(() => expect(previewCalls(h).some((query) => query.yellow_days === 3)).toBe(true));
    expect(screen.getByTestId('sentence').textContent).toContain('còn 3 ngày: vàng');
  });

  it('leaves the green line out when it is emptied: everything above yellow is green', async () => {
    const h = open();
    await ready();
    change('green_days', '');
    await waitFor(() => expect(previewCalls(h).some((query) => !('green_days' in query))).toBe(true));
    expect(screen.getByTestId('sentence').textContent).toBe('Còn nhiều hơn 2 ngày: xanh, còn 2 ngày: vàng, hôm hạn: đỏ');
  });

  it('names an unordered ladder next to the fields, asks the server nothing more, and explains why there is no preview', async () => {
    const h = open();
    await ready();
    const before = previewCalls(h).length;
    change('yellow_days', '6');
    expect(screen.getByTestId('error-green_days').textContent).toContain(text('pwf.bands.problem.order.error'));
    expect(field('green_days').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('preview-blocked')).toBeTruthy();
    expect(screen.queryByTestId('sentence')).toBeNull();
    expect(previewCalls(h).length).toBe(before);
  });

  it('writes the unit of the source whatever the rule it started from said: a policy has no unit to choose', async () => {
    const h = open({ effective: bandEffective('PROJECT_TASK', { params: { ...POLICY, unit: 'CALENDAR' } }) });
    await ready();
    change('red_days', '1');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Giữ đơn vị của nguồn' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything()));
    const body = (h.command.mock.calls.find((call) => call[0] === 'createGovernanceRuleDraft')?.[1] as { body: { params: { unit: string } } }).body;
    expect(body.params.unit).toBe('WORKING');
  });

  it('says a refusal of the preview in words', async () => {
    open({ preview: refusal('DEADLINE_BAND_THRESHOLDS_INVALID') });
    const banner = await screen.findByTestId('problem');
    expect(banner.textContent).toContain(text('pwf.problem.bandThresholds.error'));
  });

  it('checks the reminders and the escalation', async () => {
    open();
    await ready();
    change('reminder_days', '2, 5');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.bands.problem.reminderOrder.error'));
    change('reminder_days', '1, 0, -1, -2, -3, -4, -5');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.bands.problem.listSize.error', { max: 6 }));
    change('reminder_days', '400');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.bands.problem.range.error', { min: -30, max: 365 }));
    change('reminder_days', 'x');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.bands.problem.integer.error'));
    change('escalate_after_overdue_days', '0');
    expect(screen.getByTestId('error-escalate_after_overdue_days').textContent).toContain(text('pwf.bands.problem.range.error', { min: 1, max: 365 }));
    change('yellow_days', '');
    expect(screen.getByTestId('error-yellow_days').textContent).toContain(text('pwf.bands.problem.required.error'));
  });
});

describe('PWF-08: exceptions', () => {
  it('adds, edits and removes an override by kind of task, priority and phase', async () => {
    const h = open();
    await ready();
    expect(screen.getByTestId('override-count').textContent).toBe(text('wfxbands.exception.count', { count: 0 }));
    fireEvent.click(document.querySelector('[data-action="add-override"]') as HTMLElement);
    fireEvent.change(screen.getByTestId('field-overrides[0].task_kind'), { target: { value: 'MILESTONE' } });
    fireEvent.change(screen.getByTestId('field-overrides[0].priority'), { target: { value: 'CRITICAL' } });
    change('overrides[0].phase', 'EXECUTION');
    change('overrides[0].green_days', '10');
    change('overrides[0].yellow_days', '4');
    change('overrides[0].red_days', '1');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Mốc găng cần báo sớm hơn' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything()));
    const body = (h.command.mock.calls.find((call) => call[0] === 'createGovernanceRuleDraft')?.[1] as { body: { rule_type: string; code: string; params: Record<string, unknown> } }).body;
    expect(body.rule_type).toBe('DEADLINE_BAND_POLICY');
    expect(body.code).toBe('PROJECT_TASK');
    expect(body.params.overrides).toEqual([{ match: { task_kind: 'MILESTONE', priority: 'CRITICAL', phase: 'EXECUTION' }, green_days: 10, yellow_days: 4, red_days: 1 }]);
    expect(await screen.findByTestId('written')).toBeTruthy();
    cleanup();
    open();
    await ready();
    fireEvent.click(document.querySelector('[data-action="add-override"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-action="remove-override-0"]') as HTMLElement);
    expect(screen.getByTestId('override-count').textContent).toBe(text('wfxbands.exception.count', { count: 0 }));
  });

  it('names a wrong phase code and an unordered override next to their fields', async () => {
    open();
    await ready();
    fireEvent.click(document.querySelector('[data-action="add-override"]') as HTMLElement);
    change('overrides[0].phase', 'bad phase');
    change('overrides[0].green_days', '1');
    change('overrides[0].yellow_days', '2');
    change('overrides[0].red_days', '0');
    expect(screen.getByTestId('error-overrides[0].phase').textContent).toContain(text('pwf.bands.problem.phase.error'));
    expect(screen.getByTestId('error-overrides[0].green_days').textContent).toContain(text('pwf.bands.problem.order.error'));
  });
});

describe('PWF-08: steps with their own thresholds (R59)', () => {
  it('lists, read-only, the steps of the templates in force that carry their own thresholds, with a way to the process', async () => {
    open({ templates: { PUBLIC_INVESTMENT: templateEffective({ params: withOwnBands('Đầu tư công: xây dựng') }) } });
    const block = await screen.findByTestId('step-bands');
    const rows = await within(block).findAllByRole('row');
    // One head row and one step: the first task of the template.
    expect(rows).toHaveLength(2);
    const cells = [...(rows[1] as HTMLElement).querySelectorAll('td')].map((cell) => cell.textContent);
    expect(cells.slice(0, 6)).toEqual(['Đầu tư công: xây dựng', 'Chuẩn bị đầu tư', 'Lập báo cáo nghiên cứu khả thi', '1', '3', '6']);
    expect(within(block).getByRole('link', { name: text('wfxbands.steps.open.label', { step: 'Lập báo cáo nghiên cứu khả thi' }) }).getAttribute('href')).toContain('PUBLIC_INVESTMENT');
    expect(screen.getByTestId('step-count').textContent).toBe(text('wfxbands.steps.count', { count: 1 }));
    // Nothing in the block can be changed here.
    expect(block.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('says so when no step carries thresholds of its own', async () => {
    open();
    expect((await screen.findByTestId('step-bands-empty')).textContent).toBe(text('wfxbands.steps.empty.text'));
    expect(screen.getByTestId('step-count').textContent).toBe(text('wfxbands.steps.count', { count: 0 }));
  });

  it('is shown for the project tasks only: the other sources have no steps', async () => {
    open({ path: '/pwf/pwf-08?code=HOME_WORK' });
    await ready();
    expect(screen.queryByTestId('step-bands')).toBeNull();
  });

  it('keeps the policy usable when the templates cannot be read, and says the list may be incomplete', async () => {
    open({ templates: { PUBLIC_INVESTMENT: refusal('INTERNAL_ERROR', 500) } });
    expect(await screen.findByTestId('step-bands-failed')).toBeTruthy();
    expect(field('green_days').value).toBe('5');
  });

  it('is not read for a person who may not read the workflow', () => {
    const h = open({ permissions: [] });
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('PWF-08: the rule store', () => {
  it('writes a draft of the whole policy with the period and the reason', async () => {
    const h = open();
    await ready();
    change('red_days', '1');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('period-problems')).textContent).toContain(text('gova1.form.error.reason', { min: 5, max: 500 }));
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Đỏ từ 1 ngày làm việc' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything()));
    const body = (h.command.mock.calls.find((call) => call[0] === 'createGovernanceRuleDraft')?.[1] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ rule_type: 'DEADLINE_BAND_POLICY', code: 'PROJECT_TASK', params: { unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 1, reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 }, reason: 'Đỏ từ 1 ngày làm việc' });
  });

  it('says a refusal of the module when the store rejects the unit of the rule', async () => {
    open({ commands: { createGovernanceRuleDraft: refusal('DEADLINE_BAND_UNIT_MISMATCH') } });
    await ready();
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Lưu chính sách' } });
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('pwf.problem.bandUnit.error'));
  });

  it('lists the versions and lets a third person approve a submitted one, never the maker', async () => {
    open({ versions: [bandVersion(2, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: OTHER, submitted_by: OTHER })] });
    expect(await screen.findByRole('button', { name: text('gova1.move.approve') })).not.toBeDisabled();
    cleanup();
    open({ versions: [bandVersion(2, { status: 'SUBMITTED', phase: 'SUBMITTED' })], effective: bandEffective() });
    const approve = await screen.findByRole('button', { name: text('gova1.move.approve') });
    expect(approve).not.toBeDisabled();
    expect(screen.getByTestId('from-2').getAttribute('href')).toBe('/pwf/pwf-08?code=PROJECT_TASK');
  });
});

describe('PWF-08: accessibility', () => {
  it('has no serious accessibility violation with an override open and a problem shown', async () => {
    open();
    await ready();
    fireEvent.click(document.querySelector('[data-action="add-override"]') as HTMLElement);
    change('overrides[0].yellow_days', 'x');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
