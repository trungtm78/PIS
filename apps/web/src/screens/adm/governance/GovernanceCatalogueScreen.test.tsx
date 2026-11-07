import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { harness, mount } from '../../sas/test-support';
import GovernanceCatalogueScreen from './GovernanceCatalogueScreen';
import { ALL, READ, catalogueBody, refusal, routeOf, serve, text } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('ADM-19');
const open = (answer: unknown = catalogueBody(), permissions: readonly string[] = ALL) => {
  const h = serve({ getGovernanceRuleCatalog: answer });
  mount(<GovernanceCatalogueScreen route={route} />, h, permissions, '/adm/adm-19');
  return h;
};

describe('ADM-19: the catalogue of governance rules', () => {
  it('lists each rule type with its owner, its codes and how many use a rule of their own or the default', async () => {
    const h = open();
    expect(await screen.findByText('ALERT_TYPE')).toBeTruthy();
    expect(h.read.mock.calls[0]?.[0]).toBe('getGovernanceRuleCatalog');
    const alert = document.querySelector('[data-rule-type="ALERT_TYPE"]') as HTMLElement;
    // owner module, then 2 codes, 1 with its own rule, 1 on the default.
    const cells = within(alert).getAllByRole('cell');
    expect(cells[1]?.textContent).toContain('ADM');
    expect(cells[2]?.textContent).toBe('2');
    expect(cells[3]?.textContent).toBe('1');
    expect(cells[4]?.textContent).toBe('1');
    expect(within(alert).getByText(text('gova1.catalogue.readBy', { modules: 'NOT, HOME, ADM' }))).toBeTruthy();
    expect(within(alert).getByText(text('gova1.catalogue.asOf', { day: '08/11/2026' }))).toBeTruthy();
    expect(within(alert).getByText(text('gova1.catalogue.formula', { formula: 'Một loại cảnh báo nói ai phải làm, làm gì và khi nào xét lại' }))).toBeTruthy();
    expect(screen.getByTestId('open-ALERT_TYPE').getAttribute('href')).toBe('/adm/adm-20?type=ALERT_TYPE');
    expect(screen.getByTestId('link-alert-types').getAttribute('href')).toBe('/adm/adm-23');
    expect(document.querySelectorAll('table caption').length).toBe(1);
  });

  it('AC-ADM-13 says "chưa kiểm chứng" in words for a type whose numbers were not confirmed, and "đã kiểm chứng" for one that was', async () => {
    open();
    await screen.findByText('ALERT_TYPE');
    const rag = document.querySelector('[data-rule-type="RAG_THRESHOLDS"]') as HTMLElement;
    expect(within(rag).getByText(text('gova1.legal.unverified'))).toBeTruthy();
    const alert = document.querySelector('[data-rule-type="ALERT_TYPE"]') as HTMLElement;
    expect(within(alert).getByText(text('gova1.legal.verified'))).toBeTruthy();
    expect(within(alert).queryByText(text('gova1.legal.unverified'))).toBeNull();
  });

  it('totals the types, codes, codes with a rule of their own, codes on the default and the types not verified', async () => {
    open();
    await screen.findByText('ALERT_TYPE');
    const tile = (label: string) => screen.getByText(text(label), { selector: '.ui-kpi__label' }).closest('.ui-kpi') as HTMLElement;
    expect(within(tile('gova1.catalogue.kpi.types')).getByText('3')).toBeTruthy();
    expect(within(tile('gova1.catalogue.kpi.codes')).getByText('4')).toBeTruthy();
    expect(within(tile('gova1.catalogue.kpi.rules')).getByText('1')).toBeTruthy();
    expect(within(tile('gova1.catalogue.kpi.defaults')).getByText('3')).toBeTruthy();
    expect(within(tile('gova1.catalogue.kpi.unverified')).getByText('2')).toBeTruthy();
  });

  it('filters by owner and by "not verified", counts the applied filters and clears them', async () => {
    open();
    await screen.findByText('ALERT_TYPE');
    fireEvent.change(screen.getByTestId('owner'), { target: { value: 'CTR' } });
    expect(screen.queryByText('ALERT_TYPE')).toBeNull();
    expect(screen.getByText('CHANGE_ORDER_TIER')).toBeTruthy();
    fireEvent.click(screen.getByTestId('only-unverified'));
    fireEvent.change(screen.getByTestId('owner'), { target: { value: 'ADM' } });
    // Verified ADM type is filtered out by "not verified": the table says the filters found nothing and offers the way back.
    expect(screen.getByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: text('ui.dataTable.clearFilters') })[0] as HTMLElement);
    expect(await screen.findByText('ALERT_TYPE')).toBeTruthy();
    expect(screen.getByText('RAG_THRESHOLDS')).toBeTruthy();
  });

  it('finds a type by one of its codes', async () => {
    open();
    await screen.findByText('ALERT_TYPE');
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'disbursement' } });
    expect(screen.queryByText('ALERT_TYPE')).toBeNull();
    expect(screen.getByText('RAG_THRESHOLDS')).toBeTruthy();
  });

  it('marks a stored type that the system no longer registers', async () => {
    const body = catalogueBody();
    body.items.push({ ...(body.items[0] as object), rule_type: 'OLD_RULE', registered: false, owner_module: null, modules: [], formula: null, source: null, as_of: null, legal_status: null, schema: null, codes: [] } as never);
    open(body);
    expect(await screen.findByText('OLD_RULE')).toBeTruthy();
    expect(screen.getByText(text('gova1.catalogue.unregistered'))).toBeTruthy();
  });

  it('shows a skeleton while loading and never the number 0', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<GovernanceCatalogueScreen route={route} />, h, ALL, '/adm/adm-19');
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names a failed read as an error and reads again on retry (never an empty list)', async () => {
    let calls = 0;
    const h = harness(() => (calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : catalogueBody()));
    mount(<GovernanceCatalogueScreen route={route} />, h, ALL, '/adm/adm-19');
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByText('ALERT_TYPE')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('is empty only when the server says there is no type', async () => {
    open({ items: [] });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
  });

  it('is denied for a person who may not read the rules, and reads nothing', () => {
    const h = open(catalogueBody(), []);
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('is denied when the server refuses the read for the scope', async () => {
    const h = harness(() => refusal('SCOPE_DENIED', 403));
    mount(<GovernanceCatalogueScreen route={route} />, h, [READ], '/adm/adm-19');
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByText('ALERT_TYPE');
    await waitFor(async () => expect(describeViolations(await seriousViolations(document.body))).toEqual([]));
  });
});
