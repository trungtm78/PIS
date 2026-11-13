import { ApiError } from '@machvon/api-client';
import { DIS_GOLDEN } from '@machvon/contracts';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { DISBURSEMENT_REQUIRED_TERMS } from '../../mdm/model';
import { DEFINITION_READER, client, mount, routeOf, world } from '../report/test-support';
import DefinitionsScreen from './DefinitionsScreen';

const ROUTE = routeOf('DIS-25', 'FR-DIS-25');
const OWNER = '00000000-0000-4000-8000-000000000002';

afterEach(cleanup);

const term = (n: number, code: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-00000000f${String(n).padStart(3, '0')}`,
  term_code: code,
  term_vi: `Định nghĩa ${code}`,
  definition: `Định nghĩa đề xuất của ${code}.`,
  formula_ref: `formula(${code})`,
  domain: 'DISBURSEMENT',
  owner_membership_id: OWNER,
  legal_basis: null,
  revision: 1,
  status,
  approved_by: null,
  effective_from: null,
  supersedes_id: null,
  created_by: '00000000-0000-4000-8000-000000000001',
  decision_reason: null,
  version: 2,
  ...over,
});
const allTerms = (status: string) => DISBURSEMENT_REQUIRED_TERMS.map((code, n) => term(n + 1, code, status));

const open = (glossary: Array<Record<string, unknown>>, failing?: Error) => {
  const h = client(world({ glossary, failing: failing === undefined ? new Map() : new Map([['listGlossaryTerms', failing]]) }));
  mount(<DefinitionsScreen route={ROUTE} />, h, { permissions: DEFINITION_READER, path: '/dis/dis-25' });
  return h;
};

const rowOfTerm = (table: HTMLElement, code: string): HTMLElement => table.querySelector(`[data-term="${code}"]`)?.closest('tr') as HTMLElement;

describe('DIS-25 metric definitions and the golden fixtures', () => {
  it('AC-ST-DIS-011-1 / UAT-AC257 / UI-DIS-25: shows the definitions with the label that they await the sign-off of D03, each with its formula, and the seven fixtures with their expected numbers', async () => {
    open(allTerms('IN_REVIEW'));
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.definitions.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('definitions-pending')).textContent).toBe('CHỜ KÝ D03');
    expect(screen.queryByTestId('definitions-signed')).toBeNull();
    const table = screen.getByRole('table', { name: vi_['dis.definitions.terms.aria'] });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(DISBURSEMENT_REQUIRED_TERMS.length);
    const ytd = rowOfTerm(table, 'GIAI_NGAN_YTD');
    expect(table.querySelector('[data-term="GIAI_NGAN_YTD"]')?.getAttribute('data-status')).toBe('IN_REVIEW');
    expect(within(ytd).getByText('formula(GIAI_NGAN_YTD)')).toBeTruthy();
    expect(within(ytd).getByText(vi_['dis.definitions.term.inReview'])).toBeTruthy();
    expect(within(ytd).getByText('Chờ ký D03')).toBeTruthy();
    // The basis each metric is counted on (DIS-25 "Basis"), read from its code.
    const words = vi_ as Record<string, string>;
    expect(within(ytd).getByText(words['dis.definitions.basis.ytd'] ?? '')).toBeTruthy();
    expect(within(rowOfTerm(table, 'GIAI_NGAN_PERIOD')).getByText(words['dis.definitions.basis.period'] ?? '')).toBeTruthy();
    expect(within(rowOfTerm(table, 'MAU_SO_KH_TONG')).getByText(words['dis.definitions.basis.plan'] ?? '')).toBeTruthy();
    const fixtures = screen.getByRole('table', { name: vi_['dis.definitions.fixtures.aria'] });
    expect(Array.from(fixtures.querySelectorAll('[data-fixture]')).map((row) => row.getAttribute('data-fixture'))).toEqual(['FX-DIS-001', 'FX-DIS-002', 'FX-DIS-003', 'FX-DIS-004', 'FX-DIS-005', 'FX-DIS-006', 'FX-DIS-007']);
    expect(screen.getByTestId('expected-FX-DIS-004').textContent).toBe('{"rate_pm_pct":"60.0000","rate_total_pct":"48.0000"}');
    expect(screen.getByTestId('expected-FX-DIS-001').textContent).toContain('"total_vnd":"420000000"');
    expect(screen.getByTestId('expected-FX-DIS-001').textContent).toContain('"ctmtqg_vnd":"40000000"');
    expect(screen.getByTestId('expected-FX-DIS-003').textContent).toContain('"unit_rate_pm_pct":"14.0000"');
    // Each fixture carries the label too, and the sentence of the case in words.
    expect(within(fixtures.querySelector('[data-fixture="FX-DIS-005"]')?.closest('tr') as HTMLElement).getByText('CHỜ KÝ D03')).toBeTruthy();
    expect(within(fixtures).getByText(vi_['dis.definitions.fixture.fx007'])).toBeTruthy();
    for (const fixture of DIS_GOLDEN) expect(screen.getByTestId(`given-${fixture.id}`).textContent).toBe(JSON.stringify(fixture.given));
  });

  it('AC-ST-DIS-011-3: has no control that edits, approves or signs: only a link to the glossary where the owner does it, and the same once everything is signed', async () => {
    open(allTerms('IN_REVIEW'));
    await screen.findByRole('table', { name: vi_['dis.definitions.terms.aria'] });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
    expect(screen.getByRole('link', { name: vi_['dis.definitions.glossary.link'] }).getAttribute('href')).toBe('/mdm/mdm-34');
    expect(screen.getByTestId('definitions-readonly').textContent).toContain(vi_['dis.definitions.readonly.note']);
    cleanup();
    open(allTerms('PUBLISHED'));
    expect(await screen.findByTestId('definitions-signed')).toBeTruthy();
    expect(screen.queryByTestId('definitions-pending')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
  });

  it('says a term is not proposed when the glossary has none, and does not count the definitions as signed while one is short of being published', async () => {
    const published = DISBURSEMENT_REQUIRED_TERMS.slice(1).map((code, n) => term(n + 10, code, 'PUBLISHED'));
    open(published);
    const table = await screen.findByRole('table', { name: vi_['dis.definitions.terms.aria'] });
    const missing = rowOfTerm(table, DISBURSEMENT_REQUIRED_TERMS[0] as string);
    expect(table.querySelector(`[data-term="${DISBURSEMENT_REQUIRED_TERMS[0]}"]`)?.getAttribute('data-status')).toBe('MISSING');
    expect(within(missing).getByText(vi_['dis.definitions.term.none'])).toBeTruthy();
    expect(within(missing).getByText(vi_['dis.definitions.term.missing'])).toBeTruthy();
    expect(screen.getByTestId('definitions-pending').textContent).toBe('CHỜ KÝ D03');
  });

  it('shows the published revision of a term even when a newer revision is in review, and ignores the terms of other domains', async () => {
    const [first, ...rest] = DISBURSEMENT_REQUIRED_TERMS;
    open([
      term(1, first as string, 'PUBLISHED', { revision: 1, definition: 'Bản đã ký.' }),
      term(2, first as string, 'IN_REVIEW', { revision: 2, definition: 'Bản mới đang chờ duyệt.' }),
      ...rest.map((code, n) => term(n + 3, code, 'PUBLISHED')),
      term(20, 'OTHER_TERM', 'IN_REVIEW', { domain: 'OTHER' }),
    ]);
    const table = await screen.findByRole('table', { name: vi_['dis.definitions.terms.aria'] });
    const row = rowOfTerm(table, first as string);
    expect(within(row).getByText('Bản đã ký.')).toBeTruthy();
    expect(within(row).queryByText('Bản mới đang chờ duyệt.')).toBeNull();
    expect(screen.getByTestId('definitions-signed')).toBeTruthy();
    expect(table.querySelector('[data-term="OTHER_TERM"]')).toBeNull();
  });

  it('is in each of the states of a screen: loading while the glossary is read, an error that can be tried again, and a refusal for a person who may not read it', async () => {
    open([], new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }));
    expect(await screen.findByRole('heading', { level: 1, name: vi_['states.denied.title'] })).toBeTruthy();
    cleanup();
    open([], new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
    cleanup();
    open(allTerms('IN_REVIEW'));
    expect(screen.queryByRole('table', { name: vi_['dis.definitions.terms.aria'] })).toBeNull();
    expect(await screen.findByRole('table', { name: vi_['dis.definitions.terms.aria'] })).toBeTruthy();
  });
});
