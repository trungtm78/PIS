import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { describeProblem } from '../model';
import { EMPTY_CHOICE } from '../process/model';
import type { ChoiceForm, Suggestion } from '../process/model';
import { suggestion } from '../process/test/fixtures';
import { refusal, text } from '../test/fixtures';
import { ProcessChooser } from './ProcessChooser';
import type { ChooserMode, ChooserStep, ProcessChooserProps } from './ProcessChooser';

afterEach(cleanup);

const tree = [
  { id: 'u-so', code: 'SO', name: 'Sở Xây dựng', parentId: null, depth: 0 },
  { id: 'u-pb', code: 'PB', name: 'Phòng Thẩm định', parentId: 'u-so', depth: 1 },
];
const units = (over: Record<string, unknown> = {}) => ({
  refs: [
    { unit_ref: 'PROJECT_OWNER', unit_id: 'u-1', unit_name: 'Sở Giao thông', source: 'PROJECT' as const, party_name: null },
    { unit_ref: 'PROJECT_PARTY:APPRAISER', unit_id: null, unit_name: null, source: 'NONE' as const, party_name: 'Đơn vị thẩm định' },
    { unit_ref: 'UNIT:abc', unit_id: 'u-2', unit_name: 'Sở Tài chính', source: 'TEMPLATE' as const, party_name: null },
  ],
  unresolved: ['PROJECT_PARTY:APPRAISER'],
  ...over,
});

interface Run {
  onChange: ReturnType<typeof vi.fn>;
  last: () => ChoiceForm;
}

/** The chooser held in state like a screen holds it; every change is recorded. */
function show(over: Partial<ProcessChooserProps> = {}, start: Partial<ChoiceForm> = {}, step: ChooserStep = 1, answer: Suggestion | undefined = suggestion({ preview: { units: units() } }), mode: ChooserMode = 'start'): Run {
  const onChange = vi.fn();
  let latest: ChoiceForm = { ...EMPTY_CHOICE, ...start };
  function Host() {
    const [form, setForm] = useState<ChoiceForm>(latest);
    const [at, setAt] = useState<ChooserStep>(step);
    latest = form;
    return (
      <ProcessChooser
        mode={mode}
        step={at}
        onStep={setAt}
        form={form}
        onChange={(patch) => {
          onChange(patch);
          setForm((current) => ({ ...current, ...patch }));
        }}
        suggestion={answer}
        loading={false}
        failed={false}
        onRetry={() => undefined}
        units={tree}
        disabled={false}
        showProblems={false}
        withoutStart="Để trống thì ghi nhận không có workflow."
        {...over}
      />
    );
  }
  render(<Host />);
  return { onChange, last: () => latest };
}
const goTo = (step: number) => fireEvent.click(document.querySelector(`.pwfc-steps__button[data-step="${step}"]`) as HTMLElement);

describe('Chọn quy trình: step 1, the process', () => {
  it('says what the rule suggests and why, offers every process, marks one nobody confirmed and shows how big it is', () => {
    show({}, {});
    const box = screen.getByTestId('kind-suggestion');
    expect(box.textContent).toContain(text('pwf6.kind.suggested.label'));
    expect(box.textContent).toContain('Dự án đầu tư công xây dựng');
    expect(box.getAttribute('data-suggested')).toBe('PUBLIC_INVESTMENT');
    expect(box.textContent).toContain(text('pwf.process.basis.default.text'));
    expect(within(screen.getByTestId('kind-template')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'PUBLIC_INVESTMENT', 'PUBLIC_REPAIR']);
    expect(screen.getByTestId('kind-unverified')).toBeTruthy();
    expect(screen.getByTestId('template-counts').textContent).toContain(text('pwf.process.preview.counts.text', { phases: 6, steps: 13, tasks: 34 }));
    expect(screen.getByTestId('kind-template-unverified')).toBeTruthy();
  });

  it('takes the suggestion on request, and asks for a reason only when the choice goes against the rule', () => {
    const run = show({}, { templateCode: 'PUBLIC_REPAIR' });
    expect(screen.getByTestId('kind-reason')).toBeTruthy();
    fireEvent.change(screen.getByTestId('kind-reason'), { target: { value: 'Dự án sửa chữa' } });
    expect(run.last().reason).toBe('Dự án sửa chữa');
    fireEvent.click(screen.getByTestId('use-suggestion'));
    expect(run.last().templateCode).toBe('PUBLIC_INVESTMENT');
    expect(screen.queryByTestId('kind-reason')).toBeNull();
    expect(screen.queryByTestId('use-suggestion')).toBeNull();
  });

  it('asks for the facts only the chosen process branches on', () => {
    show({}, { templateCode: 'PUBLIC_REPAIR' });
    expect(screen.queryByTestId('kind-group')).toBeNull();
    expect(screen.queryByTestId('kind-funding')).toBeNull();
    cleanup();
    show({}, { templateCode: 'PUBLIC_INVESTMENT' });
    expect(screen.getByTestId('kind-group')).toBeTruthy();
    expect(screen.getByTestId('kind-funding')).toBeTruthy();
  });

  it('offers the kind of project only when the screen holds one', () => {
    show({ projectTypes: [{ value: 'CONSTRUCTION', label: 'Xây dựng' }] });
    expect(within(screen.getByTestId('kind-type')).getAllByRole('option').map((option) => option.textContent)).toEqual([text('pwf.process.fact.unknown.option'), 'Xây dựng']);
    cleanup();
    show();
    expect(screen.queryByTestId('kind-type')).toBeNull();
  });

  it('says there is no suggestion, that the caller may not start a workflow, that the suggestion cannot be read, and a process the rule names that does not exist', () => {
    show({ failed: true }, {}, 1, suggestion({ suggested_template_code: null, basis: 'NONE', can_start: false, preview: null, unknown_templates: ['RETIRED_ONE'] }));
    expect(screen.getByTestId('kind-suggestion').textContent).toBe(text('pwf.process.basis.none.text'));
    expect(screen.getByTestId('kind-denied').textContent).toBe(text('pwf.process.kind.denied.text'));
    expect(screen.getByTestId('kind-failed').textContent).toContain(text('pwf.process.kind.failed.text'));
    expect(screen.getByTestId('kind-unknown').textContent).toBe(text('pwf.process.kind.unknownTemplates.text', { codes: 'RETIRED_ONE' }));
    expect((screen.getByTestId('kind-template') as HTMLSelectElement).disabled).toBe(true);
  });

  it('offers the processes of the catalogue when the rule answered none', () => {
    show({ suggestion: undefined, fallbackTemplates: [{ code: 'A', name: 'Quy trình A', unverified: false }] });
    expect(within(screen.getByTestId('kind-template')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'A']);
  });

  it('puts the reason in the first step when it is what is missing', () => {
    show({ showProblems: true }, { plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' });
    expect(within(screen.getByTestId('kind-problems')).getAllByRole('listitem').map((item) => item.getAttribute('data-problem'))).toEqual(['reasonRequired']);
    expect(screen.getByTestId('kind-reason').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Chọn quy trình: step 2, the day and the units', () => {
  it('says what each party of the process stands for here: the unit and where it comes from, and a unit to choose for the one nobody can name', () => {
    show({}, { plannedStart: '2026-12-01' }, 2);
    const table = screen.getByTestId('units');
    expect(within(table).getByTestId('resolved-PROJECT_OWNER').textContent).toContain('Sở Giao thông');
    expect(within(table).getByTestId('resolved-PROJECT_OWNER').textContent).toContain(text('pwfp.choose.source.project.text'));
    expect(within(table).getByText(text('pwfp.choose.ref.owner.word'))).toBeTruthy();
    expect(within(table).getByTestId('resolved-UNIT:abc').textContent).toContain(text('pwfp.choose.source.template.text'));
    const open = table.querySelector('[data-ref="PROJECT_PARTY:APPRAISER"]') as HTMLElement;
    expect(open.getAttribute('data-open')).toBe('true');
    expect(within(open).getByText('Đơn vị thẩm định')).toBeTruthy();
    expect(within(open).getByRole('combobox', { name: /Đơn vị thẩm định/ })).toBeTruthy();
    // The unit tree is offered with its depth.
    expect(within(open).getAllByRole('option').map((option) => option.textContent)).toEqual([text('pwfp.choose.units.choose.option'), 'SO · Sở Xây dựng', '– PB · Phòng Thẩm định']);
  });

  it('keeps a chosen unit in the form, and says nothing is missing once every open party has one', () => {
    const run = show({ showProblems: true }, { plannedStart: '2026-12-01' }, 2);
    expect(within(screen.getByTestId('kind-problems')).getByRole('listitem').textContent).toBe(text('pwfp.choose.problem.unitsRequired.text', { units: 'Đơn vị thẩm định' }));
    expect(screen.getByTestId('unit-PROJECT-PARTY-APPRAISER').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByTestId('unit-PROJECT-PARTY-APPRAISER'), { target: { value: 'u-pb' } });
    expect(run.last().units).toEqual({ 'PROJECT_PARTY:APPRAISER': 'u-pb' });
    expect(screen.queryByTestId('kind-problems')).toBeNull();
  });

  it('says nothing needs choosing for a process with no unit, and why the units are not there yet', () => {
    show({}, { plannedStart: '2026-12-01' }, 2, suggestion({ preview: { units: { refs: [], unresolved: [] } } }));
    expect(screen.getByTestId('units-none')).toBeTruthy();
    cleanup();
    show({}, {}, 2, suggestion({ preview: null }));
    expect(screen.getByTestId('units-waiting').textContent).toBe(text('pwfp.choose.units.needStart.text'));
    cleanup();
    show({}, { plannedStart: '2026-12-01' }, 2, suggestion({ preview: null }));
    expect(screen.getByTestId('units-waiting').textContent).toBe(text('pwfp.choose.units.none.text'));
  });

  it('says a unit of the process that is no longer in force, and that the tree of units could not be read', () => {
    show({ unitsFailed: true, showProblems: true }, { plannedStart: '2026-12-01', units: { 'PROJECT_PARTY:APPRAISER': 'u-pb' } }, 2, suggestion({ preview: { units: units({ unknown: ['UNIT:abc'] }) } }));
    expect(screen.getByTestId('resolved-UNIT:abc').textContent).toContain(text('pwfp.choose.units.unknown.text'));
    expect(within(screen.getByTestId('kind-problems')).getByRole('listitem').getAttribute('data-problem')).toBe('unitUnknown');
    cleanup();
    show({ unitsFailed: true }, { plannedStart: '2026-12-01' }, 2);
    expect(screen.getByTestId('units-failed')).toBeTruthy();
  });

  it('says each refusal of a unit at the cell of that unit, in words', () => {
    const cases: Array<[string, string]> = [
      ['PWF_UNIT_UNRESOLVED', 'pwfp.problem.unitUnresolved.error'],
      ['PWF_UNIT_OVERRIDE_DENIED', 'pwfp.problem.unitOverride.error'],
      ['PWF_UNIT_UNKNOWN', 'pwfp.problem.unitUnknown.error'],
    ];
    for (const [code, key] of cases) {
      show({ refusal: describeProblem(refusal(code, 422, { unit_refs: ['PROJECT_PARTY:APPRAISER'] })) }, { plannedStart: '2026-12-01' }, 2);
      const cell = screen.getByTestId('unit-error-PROJECT_PARTY:APPRAISER');
      expect(cell.textContent).toBe(text(key, { refs: 'PROJECT_PARTY:APPRAISER' }));
      expect(screen.getByTestId('unit-PROJECT-PARTY-APPRAISER').getAttribute('aria-invalid')).toBe('true');
      cleanup();
    }
  });

  it('asks for the day an adoption takes effect, in an adoption only', () => {
    show({ showProblems: true }, { plannedStart: '2026-12-01', units: { 'PROJECT_PARTY:APPRAISER': 'u-pb' } }, 2, undefined, 'adopt');
    expect(within(screen.getByTestId('kind-problems')).getAllByRole('listitem').map((item) => item.getAttribute('data-problem'))).toContain('effectiveRequired');
    expect(screen.getByTestId('effective-date').getAttribute('aria-invalid')).toBe('true');
    cleanup();
    show({}, {}, 2);
    expect(screen.queryByTestId('effective-date')).toBeNull();
  });

  it('keeps the day field off for a caller who may not start a workflow', () => {
    show({}, {}, 2, suggestion({ can_start: false }));
    expect((screen.getByTestId('kind-start') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Chọn quy trình: step 3, the schedule and the confirmation', () => {
  it('previews the finish, the working days, the steps and the time of each before anything is saved', () => {
    show({}, { plannedStart: '2026-12-01' }, 3);
    expect(screen.getByTestId('preview-finish').textContent).toBe('15/03/2028');
    expect(screen.getByTestId('preview-total').textContent).toBe(text('pwf.process.preview.days.text', { days: 330 }));
    expect(screen.getByTestId('preview-counts').textContent).toBe(text('pwf.process.preview.counts.text', { phases: 6, steps: 13, tasks: 31 }));
    const rows = within(screen.getByTestId('kind-preview')).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('Quyết định chủ trương đầu tư');
    expect(rows[2]?.textContent).toContain(text('pwf.process.step.notApplicable.word'));
  });

  it('says what a missing fact keeps from being counted, that no schedule can be shown without a day, and a year without a calendar', () => {
    show({}, { plannedStart: '2026-12-01' }, 3, suggestion({ preview: { missing_facts: ['funding_source'], project_finish: null, total_working_days: null } }));
    expect(screen.getByTestId('preview-facts').textContent).toBe(text('pwf.process.preview.missingFacts.text', { facts: text('pwf.process.fact.funding.label') }));
    cleanup();
    show({}, {}, 3, suggestion({ preview: null }));
    expect(screen.getByTestId('kind-preview-none').textContent).toBe(text('pwfp.choose.preview.none.text'));
    cleanup();
    show({}, { plannedStart: '2026-12-01' }, 3, suggestion({ preview: { findings: [{ code: 'CALENDAR_UNAVAILABLE', task: null, year: 2028 }] } }));
    expect(screen.getByTestId('preview-calendar').textContent).toBe(text('pwf.process.problem.calendarMissing.text'));
  });

  it('shows the confirmation and what an adoption adds, at the end of the last step only', () => {
    show({ confirm: <button type="button">Khởi tạo</button>, adoption: <p data-testid="dry">chạy thử</p> }, { plannedStart: '2026-12-01' }, 3);
    expect(screen.getByRole('button', { name: 'Khởi tạo' })).toBeTruthy();
    expect(screen.getByTestId('dry')).toBeTruthy();
    goTo(2);
    expect(screen.queryByRole('button', { name: 'Khởi tạo' })).toBeNull();
  });
});

describe('Chọn quy trình: the steps', () => {
  it('moves between the three steps by the buttons of the row and by "Tiếp" and "Quay lại", and says which one it is at', () => {
    show();
    const steps = [...document.querySelectorAll<HTMLElement>('.pwfc-steps__button')];
    expect(steps.map((button) => button.textContent?.replace(/^\d/, ''))).toEqual([text('pwfp.choose.step.process.word'), text('pwfp.choose.step.units.word'), text('pwfp.choose.step.confirm.word')]);
    expect(steps[0]?.getAttribute('aria-current')).toBe('step');
    fireEvent.click(document.querySelector('[data-action="chooser-next"]') as HTMLElement);
    expect(screen.getByTestId('chooser-step-2')).toBeTruthy();
    expect(steps[1]?.getAttribute('aria-current')).toBe('step');
    fireEvent.click(steps[2] as HTMLElement);
    expect((document.querySelector('[data-action="chooser-next"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-action="chooser-back"]') as HTMLElement);
    expect(screen.getByTestId('chooser-step-2')).toBeTruthy();
  });

  it('has no serious accessibility violation on any step', async () => {
    for (const step of [1, 2, 3] as const) {
      show({ showProblems: true, confirm: <button type="button">Khởi tạo</button> }, { plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' }, step);
      expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
      cleanup();
    }
  });
});
