import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import PublicPortalScreen from './PublicPortalScreen';
import type { Fetcher } from './PublicPortalScreen';
import { word } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const INFO = { as_of: '2027-03-10', title: 'Public investment of Cao Bang', publisher: 'Provincial Board', license_uri: 'https://example.org/license', publication_policy_uri: 'https://example.org/policy', record_count: 2, last_published_at: '2027-03-02T01:00:00.000Z', fields: ['project_code', 'title', 'budget_vnd'], reports_open: true, oc4ids_version: '0.9' };
const PROJECTS = { as_of: '2027-03-10', items: [{ code: 'PRJ-001', revision: 2, published_at: '2027-03-02T01:00:00.000Z', fields: { project_code: 'PRJ-001', title: 'Road to the commune', budget_vnd: '120000000000' } }], next_after: null };

type Handler = (method: string, url: string, body: unknown) => { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetcher over a handler: what the page sends is recorded, and nothing else is available to it. */
function fetcherOf(handler: Handler): { fetcher: Fetcher; calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetcher: Fetcher = (input, init) => {
    const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
    calls.push({ method: init?.method ?? 'GET', url: input, body, headers: init?.headers ?? {} });
    const answer = handler(init?.method ?? 'GET', input, body);
    return Promise.resolve({ status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: { get: (name: string) => answer.headers?.[name] ?? null }, json: () => Promise.resolve(answer.body) });
  };
  return { fetcher, calls };
}

const open = (handler: Handler) => {
  const world = fetcherOf(handler);
  render(
    <MemoryRouter>
      <PublicPortalScreen slug="cao-bang" fetcher={world.fetcher} />
    </MemoryRouter>,
  );
  return world;
};

const normal: Handler = (method, url) => {
  if (method === 'GET' && url.endsWith('/public/portals/cao-bang')) return { status: 200, body: INFO };
  if (method === 'GET' && url.includes('/projects')) return { status: 200, body: PROJECTS };
  return { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } };
};

describe('PRJ-34, the public portal', () => {
  it('UI-PRJ-34: shows the publisher, the licence and only the fields that came, with no internal id', async () => {
    const { calls } = open(normal);
    expect(await screen.findByTestId('public-project-PRJ-001')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(INFO.title);
    expect(screen.getByTestId('public-publisher').textContent).toContain('Provincial Board');
    expect(screen.getByTestId('public-count').textContent).toBe('2');
    expect(screen.getByTestId('public-fields').textContent).toBe(`${word('prj.public.field.projectCode')}, ${word('prj.public.field.title')}, ${word('prj.public.field.budgetVnd')}`);
    expect(screen.getByTestId('public-project-PRJ-001').textContent).toContain('120.000.000.000');
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4/);
    // The page asks for nothing but the portal and its projects, and sends no cookie or token.
    expect(calls.map((call) => call.url.replace(/\?.*/, ''))).toEqual(['/public/portals/cao-bang', '/public/portals/cao-bang/projects']);
    expect(calls.every((call) => call.headers.Authorization === undefined)).toBe(true);
  });

  it('has an "i" on the figures that says where they come from', async () => {
    open(normal);
    await screen.findByTestId('public-project-PRJ-001');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(word('prj.public.info.name')) }));
    expect(await screen.findByRole('dialog', { name: word('prj.public.info.name') })).toBeTruthy();
  });

  it('says that nothing is published yet, says when the portal does not exist, and when the service fails', async () => {
    open((method, url) => (url.includes('/projects') ? { status: 200, body: { ...PROJECTS, items: [] } } : { status: 200, body: INFO }));
    expect(await screen.findByTestId('public-empty')).toBeTruthy();
    cleanup();
    open(() => ({ status: 404, body: { code: 'RESOURCE_NOT_FOUND' } }));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => ({ status: 500, body: { code: 'INTERNAL_ERROR' } }));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => ({ status: 429, body: { code: 'RATE_LIMIT' }, headers: { 'Retry-After': '30' } }));
    expect((await screen.findByTestId('public-notice')).textContent).toBe('Quá nhiều yêu cầu; vui lòng thử lại sau 30 giây.');
  });

  it('shows the offline state when the network fails', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('network'));
    render(
      <MemoryRouter>
        <PublicPortalScreen slug="cao-bang" fetcher={fetcher} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(word('states.offline.title'))).toBeTruthy();
  });

  it('pages through the projects with the cursor the server gave', async () => {
    const { calls } = open((method, url) => {
      if (url.includes('/projects') && url.includes('after=PRJ-001')) return { status: 200, body: { as_of: '2027-03-10', items: [{ code: 'PRJ-002', revision: 1, published_at: '2027-03-03T01:00:00.000Z', fields: { project_code: 'PRJ-002' } }], next_after: null } };
      if (url.includes('/projects')) return { status: 200, body: { ...PROJECTS, next_after: 'PRJ-001' } };
      return { status: 200, body: INFO };
    });
    fireEvent.click(await screen.findByTestId('public-more'));
    expect(await screen.findByTestId('public-project-PRJ-002')).toBeTruthy();
    expect(screen.queryByTestId('public-more')).toBeNull();
    expect(calls.some((call) => call.url.includes('after=PRJ-001'))).toBe(true);
  });

  it('prepares the OC4IDS file from every page and offers it for download', async () => {
    open((method, url) => {
      if (url.includes('/oc4ids') && url.includes('after=PRJ-001')) return { status: 200, body: { as_of: '2027-03-10', package: { version: '0.9', projects: [{ id: 'VN-CB-PRJ-002' }] }, next_after: null } };
      if (url.includes('/oc4ids')) return { status: 200, body: { as_of: '2027-03-10', package: { version: '0.9', projects: [{ id: 'VN-CB-PRJ-001' }] }, next_after: 'PRJ-001' } };
      return normal(method, url, undefined);
    });
    fireEvent.click(await screen.findByTestId('oc4ids-prepare'));
    const link = await screen.findByTestId('oc4ids-download');
    const text = decodeURIComponent((link.getAttribute('href') ?? '').replace('data:application/json;charset=utf-8,', ''));
    expect((JSON.parse(text) as { projects: unknown[] }).projects).toHaveLength(2);
  });

  it('follows every page of the export, more than twenty of them, into one package with one envelope', async () => {
    const PAGES = 25;
    const { calls } = open((method, url) => {
      if (!url.includes('/oc4ids')) return normal(method, url, undefined);
      const match = /after=P(\d+)/.exec(url);
      const index = match === null ? 0 : Number(match[1]) + 1;
      return { status: 200, body: { as_of: '2027-03-10', package: { version: '0.9', publisher: { name: 'Provincial Board' }, projects: [{ id: `VN-CB-P${index}` }] }, next_after: index + 1 < PAGES ? `P${index}` : null } };
    });
    fireEvent.click(await screen.findByTestId('oc4ids-prepare'));
    const link = await screen.findByTestId('oc4ids-download');
    const file = JSON.parse(decodeURIComponent((link.getAttribute('href') ?? '').replace('data:application/json;charset=utf-8,', ''))) as { projects: Array<{ id: string }>; publisher: { name: string } };
    expect(file.projects).toHaveLength(PAGES);
    expect(file.projects[PAGES - 1]?.id).toBe(`VN-CB-P${PAGES - 1}`);
    expect(file.publisher.name).toBe('Provincial Board');
    expect(calls.filter((call) => call.url.includes('/oc4ids'))).toHaveLength(PAGES);
  });

  it('ends in the incomplete state, with no file offered, when the cursor of the export never ends', async () => {
    open((method, url) => (url.includes('/oc4ids') ? { status: 200, body: { as_of: '2027-03-10', package: { version: '0.9', projects: [{ id: 'VN-CB-P0' }] }, next_after: 'STUCK' } } : normal(method, url, undefined)));
    fireEvent.click(await screen.findByTestId('oc4ids-prepare'));
    expect((await screen.findByTestId('oc4ids-error')).textContent).toBe(word('prj.public.oc4ids.incomplete'));
    expect(screen.queryByTestId('oc4ids-download')).toBeNull();
  });

  it('promises that no identity is kept, takes a report, and shows the access code once with the days it was given', async () => {
    const { calls } = open((method, url, body) => {
      if (method === 'POST' && url.endsWith('/reports')) return { status: 200, body: { access_code: 'ABCDEFGH23456789ABCDEFGH23456789', received_on: '2027-03-10', acknowledge_due_on: '2027-03-17', resolve_due_on: '2027-06-08', shown_once: true, echo: body } };
      return normal(method, url, body);
    });
    expect((await screen.findByTestId('report-promise')).textContent).toBe(word('prj.public.report.promise'));
    fireEvent.change(screen.getByTestId('report-text'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByTestId('report-submit'));
    expect((await screen.findByTestId('report-error')).textContent).toBe('Nội dung cần ít nhất 20 ký tự.');
    fireEvent.change(screen.getByTestId('report-category'), { target: { value: 'PROCUREMENT_IRREGULARITY' } });
    fireEvent.change(screen.getByTestId('report-text'), { target: { value: 'A package was split to stay under the threshold of open bidding.' } });
    fireEvent.click(screen.getByTestId('report-submit'));
    expect((await screen.findByTestId('report-code')).textContent).toBe('ABCDEFGH23456789ABCDEFGH23456789');
    expect(screen.getByTestId('report-receipt').textContent).toContain(word('prj.public.report.shownOnce'));
    expect(screen.getByTestId('report-receipt').textContent).toContain('17/03/2027');
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ category: 'PROCUREMENT_IRREGULARITY', text: 'A package was split to stay under the threshold of open bidding.' });
  });

  it('says that the channel is off when the portal takes no reports', async () => {
    open((method, url) => (url.includes('/projects') ? { status: 200, body: PROJECTS } : { status: 200, body: { ...INFO, reports_open: false } }));
    expect(await screen.findByTestId('reports-closed')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('answers a rate limit on the report in words', async () => {
    open((method, url, body) => (method === 'POST' ? { status: 429, body: { code: 'RATE_LIMIT' }, headers: { 'Retry-After': '120' } } : normal(method, url, body)));
    fireEvent.change(await screen.findByTestId('report-text'), { target: { value: 'A package was split to stay under the threshold of open bidding.' } });
    fireEvent.click(screen.getByTestId('report-submit'));
    expect((await screen.findByTestId('report-error')).textContent).toBe('Quá nhiều yêu cầu; vui lòng thử lại sau 120 giây.');
  });

  it('reads the status and the answers with the code in the body of a POST, and adds to the report', async () => {
    const thread = [{ seq: 1, from: 'YOU', body: 'The two orders were placed by the same officer.', sent_on: '2027-03-10' }, { seq: 2, from: 'HANDLER', body: 'Thank you; which officer?', sent_on: '2027-03-11' }];
    const { calls } = open((method, url, body) => {
      if (method === 'POST' && url.endsWith('/reports/status')) return { status: 200, body: { as_of: '2027-03-12', category: 'CORRUPTION', status: 'ACKNOWLEDGED', received_on: '2027-03-10', acknowledged_on: '2027-03-11', closed_on: null, note: null, acknowledge_due_on: '2027-03-17', resolve_due_on: '2027-06-08', thread } };
      if (method === 'POST' && url.endsWith('/reports/reply')) return { status: 200, body: { seq: 3, received: true } };
      return normal(method, url, body);
    });
    fireEvent.change(await screen.findByTestId('status-code'), { target: { value: 'abcd-efgh-2345-6789' } });
    fireEvent.click(screen.getByTestId('status-read'));
    expect((await screen.findByTestId('status-state')).textContent).toBe(word('prj.public.status.acknowledged'));
    expect(screen.getByTestId('status-thread').textContent).toContain('Thank you; which officer?');
    expect(calls.every((call) => !call.url.includes('abcd'))).toBe(true);
    fireEvent.change(screen.getByTestId('status-reply'), { target: { value: 'It was the officer of the finance office.' } });
    fireEvent.click(screen.getByTestId('status-send'));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/reports/reply'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/reports/reply'))?.body).toEqual({ access_code: 'abcd-efgh-2345-6789', body: 'It was the officer of the finance office.' });
  });

  it('says that the code is not right without saying why', async () => {
    open((method, url, body) => (method === 'POST' ? { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } } : normal(method, url, body)));
    fireEvent.change(await screen.findByTestId('status-code'), { target: { value: 'WRONGCODE' } });
    fireEvent.click(screen.getByTestId('status-read'));
    expect((await screen.findByTestId('status-error')).textContent).toBe(word('prj.public.report.unknownCode'));
  });

  it('offers no reply once the report is closed and shows the note the handler wrote', async () => {
    open((method, url, body) => (method === 'POST' ? { status: 200, body: { as_of: '2027-03-12', category: 'CORRUPTION', status: 'RESOLVED', received_on: '2027-03-10', acknowledged_on: '2027-03-11', closed_on: '2027-03-12', note: 'The orders were merged and re-tendered.', acknowledge_due_on: null, resolve_due_on: null, thread: [] } } : normal(method, url, body)));
    fireEvent.change(await screen.findByTestId('status-code'), { target: { value: 'ABCDEFGH23456789ABCDEFGH23456789' } });
    fireEvent.click(screen.getByTestId('status-read'));
    expect((await screen.findByTestId('status-note')).textContent).toBe('The orders were merged and re-tendered.');
    expect(screen.queryByTestId('status-reply')).toBeNull();
  });
});
