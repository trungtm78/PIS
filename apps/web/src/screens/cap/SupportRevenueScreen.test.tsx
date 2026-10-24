import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import SupportRevenueScreen from './SupportRevenueScreen';
import { READER, client, line, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('CAP-14', 'FR-CAP-14');

afterEach(cleanup);

const ready = () => waitFor(() => expect(document.querySelector('[data-origin-group]')).toBeTruthy());
const group = (origin: string): HTMLElement => document.querySelector(`[data-origin-group="${origin}"]`) as HTMLElement;
const totals = (origin: string): string[] => Array.from(screen.getByTestId(`total-${origin}`).querySelectorAll('td')).map((total) => total.textContent ?? '');

describe('SupportRevenueScreen (CAP-14): central support and revenue increase', () => {
  it('shows the two as source groups of their own, never merged into the capital the Prime Minister assigned (AC-ST-CAP-001-2, UAT-AC235, UI-CAP-14)', async () => {
    mount(<SupportRevenueScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.support.page.title']);
    expect(Array.from(document.querySelectorAll('[data-origin-group]')).map((node) => node.getAttribute('data-origin-group'))).toEqual(['CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    expect(totals('CENTRAL_SUPPORT')).toEqual(['20.000', '20.000']);
    expect(totals('REVENUE_INCREASE')).toEqual(['15.000', '5.000']);
    // The capital that the Prime Minister assigned and the one the province added are not on this screen at all.
    expect(Array.from(document.querySelectorAll('[data-appropriation-id]')).map((node) => node.getAttribute('data-appropriation-id'))).toEqual([line(3).id, line(4).id]);
    const headers = Array.from(group('CENTRAL_SUPPORT').querySelectorAll('th[scope="col"]')).map((header) => header.textContent);
    expect(headers).toEqual([vi_['cap.support.column.origin'], vi_['cap.support.column.decision'], vi_['cap.support.column.scope'], vi_['cap.support.column.amount'], vi_['cap.support.column.allocated']]);
    const row = group('REVENUE_INCREASE').querySelector('tbody tr') as HTMLElement;
    expect(within(row).getByText(vi_['cap.origin.revenueIncrease.label'], { selector: 'th' })).toBeTruthy();
    expect(row.textContent).toContain(`${vi_['cap.level.local.label']} · NSDP-DTPT · 2025`);
    expect(row.textContent).toContain('4/QD-TTg ngày 2026-01-15');
    expect(screen.getByRole('note').textContent).toBe(vi_['cap.support.separate.note']);
  });

  it('adds the several lines of a group exactly, and leaves out drafts', async () => {
    const more = line(8, { origin: 'CENTRAL_SUPPORT', amount_vnd: '1234567890', allocated_total_vnd: '1', remaining_vnd: '1234567889', plan_year: 2025, source_year: 2025 });
    const draft = line(9, { origin: 'CENTRAL_SUPPORT', amount_vnd: '999000000000', status: 'DRAFT', version: 1 });
    mount(<SupportRevenueScreen route={ROUTE} />, client(world({ lines: [line(3, { origin: 'CENTRAL_SUPPORT', amount_vnd: '20000000000', allocated_total_vnd: '0' }), more, draft] })), { permissions: READER });
    await ready();
    expect(group('CENTRAL_SUPPORT').querySelectorAll('tbody tr')).toHaveLength(2);
    expect(totals('CENTRAL_SUPPORT')).toEqual(['21.234,56789', '0,000001']);
    expect(document.querySelector('[data-origin-group="REVENUE_INCREASE"]')).toBeNull();
  });

  it('is empty when there is neither, and shows the standard states for a refusal and a failure', async () => {
    mount(<SupportRevenueScreen route={ROUTE} />, client(world({ lines: [line(1)] })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    const denied = new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', detail: undefined, extensions: {} });
    mount(<SupportRevenueScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', denied]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    mount(<SupportRevenueScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', new Error('boom')]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  it('links to the book of the appropriations', async () => {
    mount(<SupportRevenueScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('link', { name: vi_['cap.support.book.link'] }).getAttribute('href')).toBe('/cap/cap-16');
  });
});
