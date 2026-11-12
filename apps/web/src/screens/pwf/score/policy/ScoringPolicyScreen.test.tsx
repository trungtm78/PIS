import { DEFAULT_STAFF_SCORING_PARAMS } from '@machvon/kernel/src/workflow-kpi.ts';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../../test/axe';
import { mountAs } from '../../templates/test/mount';
import { ALL_PERMISSIONS, refusal, routeOf, serve, text } from '../../test/fixtures';
import type { Answer } from '../../test/fixtures';
import { catalogue, effective, uuid } from '../test/fixtures';
import ScoringPolicyScreen from './ScoringPolicyScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-10');
const TYPE = 'STAFF_SCORING_POLICY';

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getEffectiveGovernanceRule: setup.effective ?? effective(TYPE, 'DEFAULT', DEFAULT_STAFF_SCORING_PARAMS as Record<string, unknown>),
      getGovernanceRuleCatalog: catalogue(),
      listGovernanceRuleVersions: { items: [] },
    },
    { createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 }, ...setup.commands },
  );
  mountAs(<ScoringPolicyScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-10' });
  return h;
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });
const ready = async () => screen.findByTestId('bands');

describe('PWF-10: reading the policy', () => {
  it('opens the default policy with every number of the rule, and says it is a default nobody confirmed', async () => {
    open();
    await ready();
    expect(field('role_factors.RESPONSIBLE').value).toBe('1');
    expect(field('role_factors.ACCOUNTABLE').value).toBe('0.5');
    expect(field('priority_weights.CRITICAL').value).toBe('2');
    expect(field('min_rated_tasks').value).toBe('5');
    expect(field('min_effective_weight').value).toBe('3');
    expect(field('calibration.max_adjustment_points').value).toBe('10');
    expect(field('calibration.min_reason_length').value).toBe('20');
    expect(field('response_window_days').value).toBe('10');
    expect(field('retention_months').value).toBe('60');
    expect((screen.getByTestId('field-period_kind') as HTMLSelectElement).value).toBe('QUARTER');
    expect((screen.getByTestId('field-cancelled_unapproved') as HTMLSelectElement).value).toBe('COUNT_AS_MISSED');
    expect((screen.getByTestId('field-second_approver') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwfs.policy.base.default'));
    expect(screen.getByTestId('unverified-note').textContent).toBe(text('pwfs.policy.unverified.hint'));
    expect(screen.getByTestId('band-count').textContent).toBe(text('pwfs.policy.bands.count', { count: 4, max: 8 }));
  });

  it('shows the four bands with their minimum scores, the last at 0', async () => {
    open();
    await ready();
    expect(field('bands[0].code').value).toBe('EXCELLENT');
    expect(field('bands[0].min_score').value).toBe('90');
    expect(field('bands[3].code').value).toBe('WEAK');
    expect(field('bands[3].min_score').value).toBe('0');
  });

  it('states that the score supports a decision and decides nothing', async () => {
    open();
    await ready();
    expect(screen.getByTestId('support-notice').textContent).toContain(text('pwfs.common.support.note'));
  });

  it('is denied without the permission to read and reads nothing', () => {
    const h = open({ permissions: [] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the policy but changes nothing when the session is read-only', async () => {
    open({ mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    expect(field('min_rated_tasks').disabled).toBe(true);
    expect(screen.queryByTestId('save')).toBeNull();
  });
});

describe('PWF-10: editing', () => {
  it('says a number out of its range next to the field, with the limits', async () => {
    open();
    await ready();
    change('calibration.max_adjustment_points', '40');
    expect(screen.getByTestId('error-calibration.max_adjustment_points').textContent).toContain(text('pwfs.rule.problem.range.error', { min: 0, max: 30 }));
    change('response_window_days', '0');
    expect(screen.getByTestId('error-response_window_days')).toBeTruthy();
    change('role_factors.INFORMED', '2');
    expect(screen.getByTestId('error-role_factors.INFORMED')).toBeTruthy();
  });

  it('says a band out of order, a duplicate code and a last band that does not start at 0', async () => {
    open();
    await ready();
    change('bands[1].min_score', '95');
    expect(screen.getByTestId('error-bands[1].min_score').textContent).toContain(text('pwfs.rule.problem.order.error'));
    change('bands[1].min_score', '75');
    change('bands[1].code', 'EXCELLENT');
    expect(screen.getByTestId('error-bands[1].code').textContent).toContain(text('pwfs.rule.problem.duplicate.error'));
    change('bands[1].code', 'GOOD');
    change('bands[3].min_score', '5');
    expect(screen.getByTestId('error-bands[3].min_score').textContent).toContain(text('pwfs.rule.problem.lastBand.error'));
  });

  it('adds a band before the last one and removes one, never below two', async () => {
    open();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.policy.band.add.action') }));
    expect(screen.getByTestId('band-count').textContent).toBe(text('pwfs.policy.bands.count', { count: 5, max: 8 }));
    expect(field('bands[4].min_score').value).toBe('0');
    expect(field('bands[3].code').value).toBe('');
    fireEvent.click(document.querySelector('[data-action="remove-band-3"]') as HTMLElement);
    expect(screen.getByTestId('band-count').textContent).toBe(text('pwfs.policy.bands.count', { count: 4, max: 8 }));
  });

  it('saves a good policy as a draft of the rule store, with exactly the params the kernel reads', async () => {
    const h = open();
    await ready();
    change('min_rated_tasks', '6');
    fireEvent.click(screen.getByTestId('field-weight_by_planned_days'));
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Nâng số việc tối thiểu theo ý kiến của công đoàn' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const call = h.command.mock.calls[0] as [string, { body: { rule_type: string; code: string; params: Record<string, unknown> } }];
    expect(call[1].body).toMatchObject({ rule_type: TYPE, code: 'DEFAULT' });
    expect(call[1].body.params).toEqual({ ...DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 6, weight_by_planned_days: false });
  });

  it('writes nothing while a number is wrong', async () => {
    const h = open();
    await ready();
    change('retention_months', '3');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Nâng số việc tối thiểu theo ý kiến của công đoàn' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('error-retention_months')).toBeTruthy());
    expect(h.command).not.toHaveBeenCalled();
  });

  it('starts from blank when nothing governs the code', async () => {
    open({ effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404), path: '/pwf/pwf-10?code=OTHER' });
    await ready();
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwfs.policy.base.blank'));
    expect(field('min_rated_tasks').value).toBe('');
    expect(within(screen.getByTestId('bands')).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('PWF-10: the states', () => {
  it('shows the error state when the rule cannot be read', async () => {
    open({ effective: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await ready();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
