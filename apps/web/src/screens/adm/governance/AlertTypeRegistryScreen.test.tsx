import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { harness, mount } from '../../sas/test-support';
import AlertTypeRegistryScreen from './AlertTypeRegistryScreen';
import { ALL, alertType, refusal, routeOf, serve, text, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('ADM-23');
const body = () => ({
  as_of: '2026-11-08',
  items: [
    alertType('APPROVAL', { source: 'APPROVAL', owner: 'APPROVER' }),
    alertType('SITE_DIARY', { source: 'SITE_DIARY', owner: 'SITE_SUPERVISOR', default_severity: 'WATCH', review_on: '2026-11-20' }),
    alertType('INFO_ONLY', { source: 'INFO', owner: 'APPROVER', expected_action: null, default_severity: 'WATCH' }),
    alertType('BROKEN_RULE', { source: 'INFO', owner: 'UNIT_LEADER', expected_action: '', default_severity: 'ACTION' }),
    alertType('OLD_TYPE', { source: 'OLD', owner: 'UNIT_LEADER', review_on: '2026-10-30', review_overdue: true, enabled: false }),
    alertType('OWN_TYPE', { source: 'OWN', owner: 'APPROVER', rule_source: 'RULE', version: 3, unverified: true, provenance: { formula: 'f', source: 's', as_of: '2026-11-08', legal_status: 'UNVERIFIED' } }),
  ],
});

const open = (answer: unknown = body(), permissions: readonly string[] = ALL, path = '/adm/adm-23') => {
  const h = serve({ listAlertTypes: answer });
  mount(<AlertTypeRegistryScreen route={route} />, h, permissions, path);
  return h;
};

const row = (code: string) => document.querySelector(`[data-code="${code}"]`) as HTMLElement;
const codes = () => Array.from(document.querySelectorAll('[data-code]')).map((one) => (one as HTMLElement).dataset.code).sort();

describe('ADM-23: the registry of alert types', () => {
  it('lists each type with its owner, expected action, consequence, hours, level, reason, review day and the rule in force', async () => {
    const h = open();
    await screen.findByTestId('open-APPROVAL');
    expect(h.read.mock.calls[0]?.[0]).toBe('listAlertTypes');
    const approval = row('APPROVAL');
    expect(within(approval).getByText('APPROVER')).toBeTruthy();
    expect(within(approval).getByText('Xem hồ sơ và quyết định')).toBeTruthy();
    expect(within(approval).getByText('Hồ sơ bị dừng')).toBeTruthy();
    expect(within(approval).getByText('72')).toBeTruthy();
    expect(within(approval).getByText(text('gova1.severity.action'))).toBeTruthy();
    expect(within(approval).getByText('Quyết định chậm là điểm nghẽn')).toBeTruthy();
    expect(within(approval).getByText('08/05/2027')).toBeTruthy();
    expect(within(approval).getByText(text('gova1.detail.force.default'))).toBeTruthy();
    expect(screen.getByTestId('open-APPROVAL').getAttribute('href')).toBe('/adm/adm-20?type=ALERT_TYPE&code=APPROVAL');
    expect(within(row('OWN_TYPE')).getByText(text('gova1.detail.force.rule', { version: 3 }))).toBeTruthy();
    expect(within(row('OWN_TYPE')).getByText(text('gova1.legal.unverified'))).toBeTruthy();
  });

  it('AC-ADM-14 badges a type with no expected action as "only Theo dõi" and flags one that breaks that rule', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    expect(within(screen.getByTestId('no-action-INFO_ONLY')).getByText(text('gova1.alerts.noAction'))).toBeTruthy();
    expect(within(screen.getByTestId('no-action-BROKEN_RULE')).getByText(text('gova1.alerts.noActionWrong'))).toBeTruthy();
    expect(screen.queryByTestId('no-action-APPROVAL')).toBeNull();
  });

  it('AC-ADM-14 marks a type past its review day and one that is near it, in words with a glyph', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    const overdue = screen.getByTestId('overdue-OLD_TYPE');
    expect(overdue.textContent).toContain(text('gova1.alerts.review.overdue', { days: 9 }));
    expect(overdue.textContent).toContain('⚠');
    expect(screen.getByTestId('soon-SITE_DIARY').textContent).toContain(text('gova1.alerts.review.soon', { days: 12 }));
    expect(screen.queryByTestId('overdue-APPROVAL')).toBeNull();
    expect(screen.queryByTestId('soon-APPROVAL')).toBeNull();
    expect(within(row('OLD_TYPE')).getByText(text('gova1.alerts.disabled'))).toBeTruthy();
  });

  it('totals the types, the ones with a rule of their own, with no action, overdue and due soon', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    const tile = (key: string) => screen.getByText(text(key), { selector: '.ui-kpi__label' }).closest('.ui-kpi') as HTMLElement;
    expect(within(tile('gova1.alerts.kpi.types')).getByText('6')).toBeTruthy();
    expect(within(tile('gova1.alerts.kpi.own')).getByText('1')).toBeTruthy();
    expect(within(tile('gova1.alerts.kpi.noAction')).getByText('2')).toBeTruthy();
    expect(within(tile('gova1.alerts.kpi.overdue')).getByText('1')).toBeTruthy();
    expect(within(tile('gova1.alerts.kpi.soon')).getByText('1')).toBeTruthy();
  });

  it('filters by source and by owner, and to the types that need a review or have no action', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    fireEvent.change(screen.getByTestId('source'), { target: { value: 'INFO' } });
    expect(codes()).toEqual(['BROKEN_RULE', 'INFO_ONLY']);
    fireEvent.change(screen.getByTestId('owner'), { target: { value: 'UNIT_LEADER' } });
    expect(codes()).toEqual(['BROKEN_RULE']);
    fireEvent.click(screen.getByTestId('clear'));
    expect(codes().length).toBe(6);
    fireEvent.click(screen.getByTestId('only-review'));
    expect(codes()).toEqual(['OLD_TYPE', 'SITE_DIARY']);
    fireEvent.click(screen.getByTestId('only-review'));
    fireEvent.click(screen.getByTestId('only-no-action'));
    expect(codes()).toEqual(['BROKEN_RULE', 'INFO_ONLY']);
  });

  it('says the filters found nothing and offers the way back', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'zzz' } });
    expect(screen.getByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: text('ui.dataTable.clearFilters') })[0] as HTMLElement);
    expect(await screen.findByTestId('open-APPROVAL')).toBeTruthy();
  });

  it('asks for one unit when the address names one', async () => {
    const h = open(body(), ALL, `/adm/adm-23?unit_id=${uuid(55)}`);
    await screen.findByTestId('open-APPROVAL');
    expect(h.read.mock.calls[0]?.[1]).toMatchObject({ query: { unit_id: uuid(55) } });
    expect(screen.getByTestId('open-APPROVAL').getAttribute('href')).toContain(`unit_id=${uuid(55)}`);
  });

  it('shows a skeleton while loading and never the number 0', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<AlertTypeRegistryScreen route={route} />, h, ALL, '/adm/adm-23');
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('names a failed read as an error and reads again on retry', async () => {
    let calls = 0;
    const h = harness(() => (calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : body()));
    mount(<AlertTypeRegistryScreen route={route} />, h, ALL, '/adm/adm-23');
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByTestId('open-APPROVAL')).toBeTruthy();
  });

  it('is empty only when the server says there is no type, and denied without the permission', async () => {
    open({ as_of: '2026-11-08', items: [] });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open(body(), []);
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByTestId('open-APPROVAL');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
