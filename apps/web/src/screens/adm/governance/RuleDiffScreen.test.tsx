import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { harness, mount } from '../../sas/test-support';
import RuleDiffScreen from './RuleDiffScreen';
import { ALL, READ, refusal, routeOf, serve, text, uuid, version } from './test/fixtures';
import type { Answer } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('ADM-22');
const TARGET = version(2, { status: 'APPROVED', phase: 'IN_FORCE', effective_from: '2026-10-05' });
const diffBody = (over: Record<string, unknown> = {}) => ({
  from: { id: uuid(101), rule_type: 'ALERT_TYPE', code: 'EXPLANATION', version: 1, source: 'RULE' },
  to: { id: uuid(102), rule_type: 'ALERT_TYPE', code: 'EXPLANATION', version: 2 },
  changes: [
    { path: 'response_hours', before: 72, after: 48 },
    { path: 'review_on', before: null, after: '2027-05-08' },
    { path: 'expected_action', before: 'Trả lời', after: null },
    { path: 'bands[0].up_to_vnd', before: 1000000, after: 2000000 },
  ],
  ...over,
});

const open = (diff: Answer = diffBody(), path = `/adm/adm-22?rule=${uuid(102)}`, permissions: readonly string[] = ALL) => {
  const h = serve({ getGovernanceRule: TARGET, listGovernanceRuleVersions: { items: [TARGET, version(1)] }, getGovernanceRuleDiff: diff });
  mount(<RuleDiffScreen route={route} />, h, permissions, path);
  return h;
};

describe('ADM-22: the difference between two versions', () => {
  it('says what to open it from when the address names no version, and reads nothing', () => {
    const h = open(diffBody(), '/adm/adm-22');
    expect(screen.getByTestId('no-target').textContent).toBe(text('gova1.diff.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows each param that was added, removed or changed with the value before and after, the kind in words and a glyph', async () => {
    const h = open();
    await screen.findByTestId('ends');
    expect(h.read.mock.calls.find(([operation]) => operation === 'getGovernanceRuleDiff')?.[1]).toMatchObject({ path: { ruleId: uuid(102) } });
    const rows = Array.from(document.querySelectorAll('[data-change]')) as HTMLElement[];
    expect(rows.map((row) => `${row.dataset.change}:${row.dataset.path}`)).toEqual(['changed:response_hours', 'added:review_on', 'removed:expected_action', 'changed:bands[0].up_to_vnd']);
    const changed = rows[0] as HTMLElement;
    expect(within(changed).getByText(text('gova1.diff.kind.changed'))).toBeTruthy();
    expect(changed.textContent).toContain('≠');
    expect(within(changed).getByText('72')).toBeTruthy();
    expect(within(changed).getByText('48')).toBeTruthy();
    expect(within(changed).getAllByText(text('gova1.unit.hours')).length).toBe(2);
    expect((rows[1] as HTMLElement).textContent).toContain('＋');
    expect(within(rows[1] as HTMLElement).getByText(text('gova1.diff.kind.added'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(text('gova1.common.absent'))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(text('gova1.diff.kind.removed'))).toBeTruthy();
    // Money is a number with its unit (đồng) and its thousands.
    expect(within(rows[3] as HTMLElement).getByText('2.000.000')).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getAllByText(text('gova1.unit.vnd')).length).toBe(2);
    expect(screen.getByTestId('counts').textContent).toContain(text('gova1.diff.count.added', { count: 1 }));
    expect(screen.getByTestId('counts').textContent).toContain(text('gova1.diff.count.removed', { count: 1 }));
    expect(screen.getByTestId('counts').textContent).toContain(text('gova1.diff.count.changed', { count: 2 }));
    expect(screen.getByTestId('from').textContent).toBe(text('gova1.diff.end.version', { version: 1 }));
  });

  it('names the default that ships as the left side of a first version, and "nothing" when there is nothing', async () => {
    open(diffBody({ from: { id: null, rule_type: 'ALERT_TYPE', code: 'EXPLANATION', version: 0, source: 'DEFAULT' } }));
    expect((await screen.findByTestId('from')).textContent).toBe(text('gova1.diff.end.default'));
    cleanup();
    open(diffBody({ from: { id: null, rule_type: 'ALERT_TYPE', code: 'EXPLANATION', version: 0, source: 'NONE' } }));
    expect((await screen.findByTestId('from')).textContent).toBe(text('gova1.diff.end.none'));
  });

  it('says the two sides are the same when no param differs', async () => {
    open(diffBody({ changes: [] }));
    expect((await screen.findByTestId('no-changes')).textContent).toBe(text('gova1.diff.none'));
  });

  it('compares with the version that is chosen: the choice goes in the address and the read', async () => {
    const h = open();
    const select = (await screen.findByTestId('against')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((option) => option.value)).toEqual(['', uuid(101)]));
    fireEvent.change(select, { target: { value: uuid(101) } });
    await waitFor(() => expect(h.read.mock.calls.some(([operation, input]) => operation === 'getGovernanceRuleDiff' && (input as { query?: { against?: string } }).query?.against === uuid(101))).toBe(true));
  });

  it('says a version that is not there, and a failed read with a retry', async () => {
    open(refusal('RESOURCE_NOT_FOUND', 404));
    expect((await screen.findByTestId('missing')).textContent).toBe(text('gova1.diff.missing'));
    cleanup();
    let calls = 0;
    const h = harness((operation) => {
      if (operation === 'getGovernanceRule') return TARGET;
      if (operation === 'listGovernanceRuleVersions') return { items: [] };
      return calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : diffBody();
    });
    mount(<RuleDiffScreen route={route} />, h, ALL, `/adm/adm-22?rule=${uuid(102)}`);
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByTestId('ends')).toBeTruthy();
  });

  it('is denied for a person who may not read, and reads nothing', () => {
    const h = open(diffBody(), `/adm/adm-22?rule=${uuid(102)}`, []);
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    expect(READ).toBe('adm.governance.read');
  });

  it('shows a skeleton while loading', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<RuleDiffScreen route={route} />, h, ALL, `/adm/adm-22?rule=${uuid(102)}`);
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByTestId('ends');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
