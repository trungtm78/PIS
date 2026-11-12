import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import { catalogue } from '../score/test/fixtures';
import { ALL_PERMISSIONS, refusal, serve, text } from '../test/fixtures';
import { KpiCodePicker } from './KpiCodePicker';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Host({ initial, disabled = false, spy }: { initial: string[]; disabled?: boolean; spy?: (codes: string[]) => void }) {
  const [codes, setCodes] = useState(initial);
  return (
    <KpiCodePicker
      taskCode="T1"
      value={codes}
      disabled={disabled}
      enabled
      onChange={(next) => {
        spy?.(next);
        setCodes(next);
      }}
    />
  );
}

const open = (initial: string[], answer: unknown = catalogue(), props: { disabled?: boolean; spy?: (codes: string[]) => void } = {}) => {
  const h = serve({ getGovernanceRuleCatalog: answer });
  mount(<Host initial={initial} {...props} />, h, ALL_PERMISSIONS);
  return h;
};

describe('the picker of the KPIs of a task (template editor)', () => {
  it('offers the codes of the KPI register as choices and ticks the ones the task holds', async () => {
    open(['PWF_ON_TIME_RATE']);
    await screen.findByTestId('kpi-picker-T1');
    expect((screen.getByTestId('kpi-pick-T1-PWF_ON_TIME_RATE') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('kpi-pick-T1-PWF_TASK_DEVIATION_DAYS') as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
  });

  it('adds and removes a code when a choice is ticked and unticked', async () => {
    const spy = vi.fn();
    open([], catalogue(), { spy });
    await screen.findByTestId('kpi-picker-T1');
    fireEvent.click(screen.getByTestId('kpi-pick-T1-PWF_RETURN_COUNT'));
    expect(spy).toHaveBeenLastCalledWith(['PWF_RETURN_COUNT']);
    fireEvent.click(screen.getByTestId('kpi-pick-T1-PWF_ON_TIME_RATE'));
    expect(spy).toHaveBeenLastCalledWith(['PWF_RETURN_COUNT', 'PWF_ON_TIME_RATE']);
    fireEvent.click(screen.getByTestId('kpi-pick-T1-PWF_RETURN_COUNT'));
    expect(spy).toHaveBeenLastCalledWith(['PWF_ON_TIME_RATE']);
  });

  it('says in words that a code the task holds is not in the register', async () => {
    open(['NOT_IN_REGISTER', 'PWF_ON_TIME_RATE']);
    expect((await screen.findByTestId('kpi-unknown-T1')).textContent).toContain(text('pwfs.picker.unknown.note', { codes: 'NOT_IN_REGISTER' }));
  });

  it('links to the editor of the KPI set and leaves the choices to the reader when the template cannot be changed', async () => {
    open([], catalogue(), { disabled: true });
    await screen.findByTestId('kpi-picker-T1');
    expect(screen.getByRole('link', { name: text('pwfs.picker.set.link') }).getAttribute('href')).toBe('/pwf/pwf-09');
    expect((screen.getByTestId('kpi-pick-T1-PWF_RETURN_COUNT') as HTMLInputElement).disabled).toBe(true);
  });

  it('stays out of the way when the register cannot be read', async () => {
    const h = open([], refusal('INTERNAL', 500));
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    expect(screen.queryByTestId('kpi-picker-T1')).toBeNull();
  });

  it('has no serious accessibility violation', async () => {
    open(['NOT_IN_REGISTER']);
    await screen.findByTestId('kpi-picker-T1');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
