import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EntryRulesScreen from './EntryRulesScreen';
import { ADMIN, AS_OF, READER, RULES, byOperation, client, mountScreen, problem, routeOf, violation, word, world } from './test/ind-test-support';
import type { MountOptions, World } from './test/ind-test-support';

const ROUTE = routeOf('IND-02', 'FR-IND-02');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(options: Options = {}) {
  const state = world(options.world);
  const h = client(state, options.command ?? byOperation({}));
  const mounted = mountScreen(<EntryRulesScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const ready = async (): Promise<void> => {
  await screen.findByTestId('rules-table');
};
const rowOf = (code: string): HTMLElement => document.querySelector(`[data-testid="rules-table"] tr[data-code="${code}"]`) as HTMLElement;
const addField = (field: string, value: string, index = 0): void => {
  const lines = screen.getAllByTestId('fact-line');
  fireEvent.change(within(lines[index] as HTMLElement).getByLabelText(word('ind.rules.try.field')), { target: { value: field } });
  fireEvent.change(within(lines[index] as HTMLElement).getByLabelText(word('ind.rules.try.value')), { target: { value } });
};
const run = (): void => {
  fireEvent.click(screen.getByRole('button', { name: word('ind.rules.try.action') }));
};

describe('EntryRulesScreen (IND-02): the rules', () => {
  it('UI-IND-02 UAT-IND-PX-01: lists each rule with its check, level, fields, range, surfaces, version and whether it is in force or only a template', async () => {
    open();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('ind.rules.page.title'));
    const cumulative = rowOf('CUMULATIVE_NOT_ABOVE_TOTAL');
    expect(cumulative.getAttribute('data-active')).toBe('true');
    expect(within(cumulative).getByText(word('ind.check.cumulativeNotAboveTotal.label'))).toBeTruthy();
    expect(within(cumulative).getByText(word('ind.rules.state.active'))).toBeTruthy();
    expect(within(cumulative).getByText(word('ind.surface.disReport.label'))).toBeTruthy();
    expect(within(cumulative).getByText('v3')).toBeTruthy();
    expect(within(cumulative).getByText(word('ind.origin.rule.label'))).toBeTruthy();
    expect(within(cumulative).getByText(`CUMULATIVE, ${word('ind.rules.fields.total', { field: 'TOTAL_INVESTMENT' })}`)).toBeTruthy();
    const range = rowOf('PROGRESS_PERCENT_IN_RANGE');
    expect(range.getAttribute('data-level')).toBe('WARN');
    expect(within(range).getByText(word('ind.rules.range.between', { min: '0', max: '100' }))).toBeTruthy();
    expect(within(range).getByText(word('ind.severity.warn.label'))).toBeTruthy();
    expect(within(range).getByText(word('ind.rules.surfaces.all'))).toBeTruthy();
    const parts = rowOf('EQUITY_PLUS_DEBT_EQUALS_TOTAL');
    expect(parts.getAttribute('data-active')).toBe('false');
    expect(within(parts).getByText(word('ind.rules.state.template'))).toBeTruthy();
    expect(within(parts).getByText(word('ind.origin.defaultUnverified.label'))).toBeTruthy();
    expect(within(parts).getByText(word('ind.rules.range.tolerance', { n: '0' }))).toBeTruthy();
    expect(screen.getByTestId('rules-summary').textContent).toBe(word('ind.rules.summary.text', { active: 1, templates: 2 }));
    expect(screen.queryByTestId('rules-none-active')).toBeNull();
  });

  it('UAT-IND-PX-01 says that no entry is held to any rule while the tenant has approved none, and links to the governance rules', async () => {
    open({ world: { rules: { ...RULES, items: RULES.items.map((one) => ({ ...one, active: false, origin: 'DEFAULT' })) } } });
    await ready();
    expect(screen.getByTestId('rules-none-active').textContent).toBe(word('ind.rules.summary.noneActive'));
    expect(within(screen.getByTestId('governance-note')).getByRole('link').getAttribute('href')).toBe('/adm/adm-19');
  });

  it('says it is loading, could not be read (and reads again), is not allowed or has no rule', async () => {
    const hanging = open({ world: { hanging: new Set(['listIndicatorEntryRules']) } });
    expect((await screen.findByTestId('rules-loading')).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('rules-table')).toBeNull();
    hanging.unmount();
    cleanup();
    const failing = open({ world: { failing: new Map([['listIndicatorEntryRules', new Error('down')]]) } });
    expect((await screen.findByTestId('rules-error')).textContent).toContain(word('ind.rules.state.error'));
    failing.state.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await ready();
    cleanup();
    open({ world: { failing: new Map([['listIndicatorEntryRules', problem('FORBIDDEN', 403)]]) } });
    expect((await screen.findByTestId('rules-denied')).textContent).toBe(word('ind.rules.state.denied'));
    cleanup();
    open({ world: { rules: { items: [], surfaces: [], checks: [], as_of: AS_OF } } });
    expect((await screen.findByTestId('rules-empty')).textContent).toBe(word('ind.rules.state.empty'));
  });
});

describe('EntryRulesScreen (IND-02): try numbers', () => {
  it('holds the numbers to the rules of the surface and shows the verdict: blocked, with the rules and their words, what was checked and what was skipped', async () => {
    const { h } = open({
      command: byOperation({
        evaluate: {
          operation_id: 'o',
          status: 'EVALUATED',
          resource_version: 0,
          allowed: false,
          violations: [violation(), violation({ rule_code: 'PROGRESS_WARNING', severity: 'WARN', check: 'VALUE_IN_RANGE', fields: ['PHYSICAL_PROGRESS'], message: 'Tiến độ trên 90 phần trăm: hãy kiểm tra.' })],
          evaluated: ['EQUITY_PLUS_DEBT_EQUALS_TOTAL', 'PROGRESS_WARNING'],
          skipped: [{ rule_code: 'CLOSED_PERIOD_LOCKED', reason: 'FACT_MISSING' }, { rule_code: 'ONLY_REPORT', reason: 'OTHER_SURFACE' }],
        },
      }),
    });
    await ready();
    fireEvent.change(screen.getByLabelText(word('ind.rules.try.surface')), { target: { value: 'INDICATOR_ENTRY' } });
    fireEvent.change(screen.getByLabelText(word('ind.rules.try.period')), { target: { value: 'LOCKED' } });
    addField('equity', '400');
    fireEvent.click(screen.getByRole('button', { name: word('ind.rules.try.add') }));
    addField('DEBT', '500', 1);
    fireEvent.click(screen.getByLabelText(word('ind.rules.try.templates')));
    run();
    const verdict = await screen.findByTestId('try-verdict');
    expect(verdict.getAttribute('data-allowed')).toBe('false');
    expect(within(verdict).getByText(word('ind.rules.try.blocked'))).toBeTruthy();
    const list = within(verdict).getByTestId('try-violations');
    expect(list.querySelector('[data-rule="EQUITY_PLUS_DEBT_EQUALS_TOTAL"]')?.getAttribute('data-severity')).toBe('BLOCK');
    expect(list.querySelector('[data-rule="PROGRESS_WARNING"]')?.getAttribute('data-severity')).toBe('WARN');
    expect(within(list).getByText(violation().message, { exact: false })).toBeTruthy();
    expect(screen.getByTestId('try-evaluated').textContent).toBe(word('ind.rules.try.evaluated', { codes: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL, PROGRESS_WARNING' }));
    const skipped = screen.getByTestId('try-skipped');
    expect(within(skipped).getByText(`CLOSED_PERIOD_LOCKED: ${word('ind.skip.factMissing.label')}`)).toBeTruthy();
    expect(within(skipped).getByText(`ONLY_REPORT: ${word('ind.skip.otherSurface.label')}`)).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith('evaluateIndicatorEntry', expect.objectContaining({ body: { surface: 'INDICATOR_ENTRY', values: { EQUITY: '400', DEBT: '500' }, period_status: 'LOCKED', include_templates: true } }));
  });

  it('says the numbers may be saved when no rule is broken, and that no rule was checked when none applies', async () => {
    open();
    await ready();
    addField('CUMULATIVE', '5');
    run();
    const verdict = await screen.findByTestId('try-verdict');
    expect(verdict.getAttribute('data-allowed')).toBe('true');
    expect(within(verdict).getByText(word('ind.rules.try.allowed'))).toBeTruthy();
    expect(within(verdict).getByText(word('ind.rules.try.noViolations'))).toBeTruthy();
    expect(screen.getByTestId('try-evaluated').textContent).toBe(word('ind.rules.try.evaluatedNone'));
    expect(screen.queryByTestId('try-skipped')).toBeNull();
  });

  it('holds the send until a field has a name in capitals and a number, and says which line is wrong', async () => {
    open();
    await ready();
    const button = screen.getByRole('button', { name: word('ind.rules.try.action') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(screen.getAllByTestId('fact-line')[0] as HTMLElement).getByLabelText(word('ind.rules.try.value')), { target: { value: '5' } });
    expect(screen.getByText(word('ind.rules.try.fault.field'))).toBeTruthy();
    expect(button.disabled).toBe(true);
    addField('CUMULATIVE', '5');
    expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: word('ind.rules.try.add') }));
    addField('CUMULATIVE', '6', 1);
    expect(screen.getAllByText(word('ind.rules.try.fault.duplicate')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: word('ind.rules.try.remove') })[1] as HTMLElement);
    expect(button.disabled).toBe(false);
  });

  it('says in words when the try fails, and clears an old verdict as soon as a number changes', async () => {
    open({ command: (operation) => (operation === 'evaluateIndicatorEntry' ? problem('VALIDATION_FAILED', 422, {}, 'values') : {}) });
    await ready();
    addField('CUMULATIVE', '5');
    run();
    expect((await screen.findByTestId('problem-note')).textContent).toContain(word('ind.problem.validation.text', { field: 'values' }));
    cleanup();
    open();
    await ready();
    addField('CUMULATIVE', '5');
    run();
    await screen.findByTestId('try-verdict');
    fireEvent.change(within(screen.getAllByTestId('fact-line')[0] as HTMLElement).getByLabelText(word('ind.rules.try.value')), { target: { value: '6' } });
    await waitFor(() => expect(screen.queryByTestId('try-verdict')).toBeNull());
  });

  it('offers no try to a reader or to a read-only session, and still lists the rules', async () => {
    open({ permissions: READER });
    await ready();
    expect(screen.getByTestId('try-noauthority').textContent).toBe(word('ind.rules.try.noAuthority'));
    expect(screen.queryByRole('button', { name: word('ind.rules.try.action') })).toBeNull();
    cleanup();
    open({ permissions: ADMIN, mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('try-readonly').textContent).toBe(word('ind.rules.try.readOnly'));
  });
});
