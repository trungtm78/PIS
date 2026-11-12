import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import DictionaryScreen from './DictionaryScreen';
import EntryRulesScreen from './EntryRulesScreen';
import MappingsScreen from './MappingsScreen';
import { ADMIN, PERIOD, PROJECT, byOperation, client, mountScreen, routeOf, violation, word, world } from './test/ind-test-support';
import type { Harness, World } from './test/ind-test-support';

afterEach(() => cleanup());

function open(element: JSX.Element, options: { world?: Partial<World>; command?: (operation: string, input: unknown) => unknown } = {}): Harness {
  const h = client(world(options.world), options.command ?? byOperation({}));
  mountScreen(element, h, { permissions: ADMIN });
  return h;
}

/** The text that describes a control: what its aria-describedby names, as a person with a screen reader would hear it. */
const descriptionOf = (control: HTMLElement): string =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();

describe('UAT-IND-A11-01 the three indicator screens', () => {
  it('UAT-IND-A11-01 IND-01 explains why the cell of a derived indicator is locked, labels the number fields, ties a wrong number to its field with aria-describedby, and has no serious axe violation', async () => {
    open(<DictionaryScreen route={routeOf('IND-01', 'FR-IND-01')} />);
    await screen.findByTestId('dictionary-table');
    // A derived indicator cannot be typed: the screen says so beside it, in words, and offers no entry for it.
    fireEvent.click(await screen.findByRole('button', { name: word('ind.dict.select.label', { code: 'RATE_YEAR_IN_FORCE' }) }));
    expect((await screen.findByTestId('detail-derived-note')).textContent).toBe(word('ind.dict.detail.derivedNote'));
    expect(screen.queryByRole('button', { name: word('ind.dict.detail.enter') })).toBeNull();

    // The entry form: every field has its label, and a wrong number names the field it belongs to.
    fireEvent.change(screen.getByLabelText(word('ind.fig.project.label')), { target: { value: PROJECT } });
    fireEvent.change(screen.getByLabelText(word('ind.fig.period.label')), { target: { value: PERIOD } });
    fireEvent.click(screen.getByRole('button', { name: word('ind.fig.load.action') }));
    await waitFor(() => expect(screen.queryByTestId('figures-loading')).toBeNull());
    const line = screen.getAllByTestId('entry-line')[0] as HTMLElement;
    fireEvent.change(within(line).getByLabelText(word('ind.fig.line.indicator')), { target: { value: 'TOTAL_INVESTMENT' } });
    const value = within(line).getByLabelText(word('ind.fig.line.value'));
    fireEvent.change(value, { target: { value: '12abc' } });
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(value)).toBe(word('ind.fig.fault.value'));
    expect(within(line).getByRole('alert').textContent).toBe(word('ind.fig.fault.value'));
    // The ids of the project and the period too: a text that is not an id is named by the field.
    const project = screen.getByLabelText(word('ind.fig.project.label'));
    fireEvent.change(project, { target: { value: 'not an id' } });
    expect(project.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(project)).toBe(word('ind.fig.project.invalid'));
    fireEvent.change(project, { target: { value: PROJECT } });
    expect(project.getAttribute('aria-describedby')).toBeNull();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-IND-A11-01 IND-02 reads each line of a trial run as an item of a list, ties a wrong number to its field, and has no serious axe violation', async () => {
    open(<EntryRulesScreen route={routeOf('IND-02', 'FR-IND-02')} />, {
      command: byOperation({
        evaluate: {
          operation_id: 'o',
          status: 'EVALUATED',
          resource_version: 0,
          allowed: false,
          violations: [violation(), violation({ rule_code: 'PROGRESS_WARNING', severity: 'WARN', check: 'VALUE_IN_RANGE', fields: ['PHYSICAL_PROGRESS'], message: 'Tiến độ trên 90 phần trăm: hãy kiểm tra.' })],
          evaluated: ['EQUITY_PLUS_DEBT_EQUALS_TOTAL', 'PROGRESS_WARNING'],
          skipped: [{ rule_code: 'CLOSED_PERIOD_LOCKED', reason: 'FACT_MISSING' }],
        },
      }),
    });
    await screen.findByTestId('rules-table');
    const fact = screen.getAllByTestId('fact-line')[0] as HTMLElement;
    const field = within(fact).getByLabelText(word('ind.rules.try.field'));
    const value = within(fact).getByLabelText(word('ind.rules.try.value'));
    fireEvent.change(field, { target: { value: 'bad field!' } });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(field)).toBe(word('ind.rules.try.fault.field'));
    fireEvent.change(field, { target: { value: 'EQUITY' } });
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(value)).toBe(word('ind.rules.try.fault.value'));
    fireEvent.change(value, { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: word('ind.rules.try.action') }));
    const verdict = await screen.findByTestId('try-verdict');
    // The verdict is a status with its words, and every violation, the evaluated rules and each skipped rule is a line of its own.
    expect(verdict.getAttribute('role')).toBe('status');
    expect(within(verdict).getByText(word('ind.rules.try.blocked'))).toBeTruthy();
    expect(within(within(verdict).getByTestId('try-violations')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(within(verdict).getByTestId('try-skipped')).getAllByRole('listitem')).toHaveLength(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-IND-A11-01 IND-03 has a mapping table with column headers and no serious axe violation', async () => {
    open(<MappingsScreen route={routeOf('IND-03', 'FR-IND-03')} />);
    const table = await screen.findByTestId('mappings-table');
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(2);
    expect(table.closest('table')?.querySelector('caption')?.textContent?.length ?? table.querySelector('caption')?.textContent?.length).toBeGreaterThan(0);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('negative control: a number field that has no description for its error is reported', async () => {
    document.body.innerHTML = '<main><h1>t</h1><input type="text" aria-invalid="true"><small role="alert">Wrong</small></main>';
    const control = document.querySelector('input') as HTMLElement;
    expect(descriptionOf(control)).toBe('');
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('label');
  });
});
