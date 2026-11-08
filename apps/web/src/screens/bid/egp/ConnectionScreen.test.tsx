import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import ConnectionScreen from './ConnectionScreen';
import { ADMIN, LAYOUT, READER, client, connection, health, mount, neverHealth, pendingItems, route, rule, staleHealth, unusedConnection } from './connection-test-support';
import type { World } from './connection-test-support';
import en from '../../../i18n/en.json';

// The words are read from the catalogues: the translator adds the keys of a part that is not folded yet to the catalogue objects, and a folded catalogue holds them, so the test reads the same either way.
const catalogue = (source: object, key: string): string => {
  const found = (source as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const word = (key: string): string => catalogue(base, key);
const wordEn = (key: string): string => catalogue(en, key);
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value: string, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function mountWith(options: { connection?: Record<string, unknown>; permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; failing?: World['failing'] } = {}) {
  const state: World = { connection: options.connection ?? connection(), ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(state, options.command);
  mount(<ConnectionScreen route={route} />, h, { permissions: options.permissions ?? ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, state };
}

const testId = (id: string): HTMLElement => screen.getByTestId(id);
const content = (id: string): string => testId(id).textContent ?? '';
const loaded = async (): Promise<void> => {
  await screen.findByTestId('status-card');
};

describe('ConnectionScreen (BID-22): the connection to the national e-procurement network', () => {
  it('UI-BID-22: shows the status card, with the adapter as a proposal that only reads files, the assumed layout, the Draft registry, the refusing API adapter and who switched it and why', async () => {
    mountWith();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('egp.connection.page.title'));
    expect(content('status-code')).toContain('egp.muasamcong');
    const adapter = content('status-adapter');
    expect(adapter).toContain('PROPOSED');
    expect(adapter).toContain('chỉ nhập tệp');
    expect(content('status-mode')).toContain(word('egp.connection.status.mode.fileImport'));
    expect(content('status-layout')).toContain(LAYOUT);
    expect(content('status-layout')).toContain(word('egp.connection.status.layout.pending'));
    expect(content('status-registry')).toContain(word('egp.connection.status.registry.draft'));
    expect(content('status-api')).toContain(word('egp.connection.status.api.missing'));
    expect(content('status-api')).toContain('EGP_API_UNAVAILABLE');
    expect(content('status-state')).toContain(word('egp.connection.status.state.enabled'));
    expect(content('status-reason')).toContain('Bắt đầu nhập tệp thử nghiệm');
    expect(content('status-changed')).toContain(text('egp.connection.status.changed.text', { name: 'Nguyễn Văn An', time: '05/11/2026 09:30' }));
    // The assumed layout is said in the card head too, by the word that every result built on it carries.
    expect(screen.getAllByText(word('egp.connection.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 2, name: word('egp.connection.section.status.title') })).toBeTruthy();
  });

  it('does not call the layout an assumption once the recipient confirmed it', async () => {
    mountWith({ connection: connection({ acceptance: 'ACCEPTABLE', last_runs: [] }) });
    await loaded();
    expect(content('status-layout')).toContain(word('egp.connection.status.layout.accepted'));
    expect(content('status-layout')).not.toContain(word('egp.connection.status.layout.pending'));
    expect(screen.queryByText(word('egp.connection.acceptance.pending.badge'))).toBeNull();
  });

  it('shows another registry status and another API status as the server wrote them', async () => {
    mountWith({ connection: connection({ registry_status: 'Active', api_adapter: { status: 'VERIFIED', reason: 'SPEC_PUBLISHED' } }) });
    await loaded();
    expect(content('status-registry')).toContain('Active');
    expect(content('status-registry')).not.toContain(word('egp.connection.status.registry.draft'));
    expect(content('status-api')).toContain('VERIFIED · SPEC_PUBLISHED');
  });

  it('puts what needs action first, and says nothing needs it when all is well', async () => {
    mountWith();
    await loaded();
    const sections = Array.from(document.querySelectorAll('h2.ui-section__title')).map((node) => node.textContent);
    expect(sections.slice(0, 3)).toEqual([word('egp.connection.section.action.title'), word('egp.connection.section.status.title'), word('egp.connection.section.freshness.title')]);
    expect(content('action-none')).toBe(word('egp.connection.action.none.text'));
  });

  describe('freshness', () => {
    it('FRESH: names the status, the age, the last import with its kind, the thresholds, no alert and figures not blocked', async () => {
      mountWith();
      await loaded();
      expect(content('freshness-status')).toContain(word('egp.connection.freshness.state.fresh'));
      expect(content('freshness-age')).toContain('26,5 giờ');
      expect(content('freshness-last')).toContain(text('egp.connection.freshness.last.value', { time: '07/11/2026 08:05', kind: word('egp.connection.kind.khlcnt.name') }));
      expect(content('freshness-thresholds')).toContain(text('egp.connection.freshness.thresholds.value', { warn: 120, max: 168 }));
      expect(content('freshness-alert')).toContain(word('egp.connection.freshness.alert.none'));
      expect(content('freshness-figures')).toContain(word('egp.connection.freshness.figures.open'));
      expect(content('freshness-explain')).toBe(word('egp.connection.freshness.explain.fresh'));
    });

    it('AGING: says the data is getting old', async () => {
      mountWith({ connection: connection({ health: health({ status: 'AGING', age_hours: 130 }) }) });
      await loaded();
      expect(content('freshness-status')).toContain(word('egp.connection.freshness.state.aging'));
      expect(content('freshness-explain')).toBe(word('egp.connection.freshness.explain.aging'));
    });

    it('STALE: reads as stale with the alert CONNECTOR_STALE and its severity in words, never as no data, and it is the first thing to act on', async () => {
      mountWith({ connection: connection({ health: staleHealth() }) });
      await loaded();
      expect(content('freshness-status')).toContain(word('egp.connection.freshness.state.stale'));
      expect(content('freshness-explain')).toBe(word('egp.connection.freshness.explain.stale'));
      expect(content('freshness-age')).toContain('200 giờ');
      expect(content('freshness-alert')).toContain('CONNECTOR_STALE');
      expect(content('freshness-alert')).toContain(word('egp.connection.severity.watch.name'));
      expect(content('action-stale')).toContain(text('egp.connection.action.stale.text', { hours: 200, max: 168 }));
      expect(content('action-stale')).toContain(word('egp.connection.severity.watch.name'));
      // The connection is not drawn as empty: the figures of the register and the history stay where they were.
      expect(screen.queryByText(base['states.empty.title'])).toBeNull();
      expect(screen.queryByText(word('egp.connection.freshness.explain.never'))).toBeNull();
      expect(screen.getByTestId('record-counts')).toBeTruthy();
    });

    it.each([
      ['URGENT', 'egp.connection.severity.urgent.name'],
      ['ACTION', 'egp.connection.severity.action.name'],
      ['WATCH', 'egp.connection.severity.watch.name'],
    ] as const)('STALE at severity %s says the level in words', async (severity, key) => {
      mountWith({ connection: connection({ health: staleHealth({ alert: { code: 'CONNECTOR_STALE', severity } }) }) });
      await loaded();
      expect(content('freshness-alert')).toContain(word(key));
    });

    it('STALE with the figures blocked says so', async () => {
      mountWith({ connection: connection({ health: staleHealth({ figures_blocked: true }) }) });
      await loaded();
      expect(content('freshness-figures')).toContain(word('egp.connection.freshness.figures.blocked'));
    });

    it('NEVER_IMPORTED: reads "Chưa nhập lần nào", with no alarm and no alert', async () => {
      mountWith({ connection: connection({ health: neverHealth() }) });
      await loaded();
      expect(content('freshness-status')).toContain('Chưa nhập lần nào');
      expect(content('freshness-explain')).toBe(word('egp.connection.freshness.explain.never'));
      expect(content('freshness-age')).toContain(word('egp.connection.freshness.age.none'));
      expect(content('freshness-last')).toContain(word('egp.connection.freshness.last.none'));
      expect(content('freshness-alert')).toContain(word('egp.connection.freshness.alert.none'));
      expect(screen.queryByTestId('action-stale')).toBeNull();
      expect(content('action-none')).toBe(word('egp.connection.action.none.text'));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says the rule is unverified when the server flags it, and not when it is verified', async () => {
      mountWith({ connection: connection({ health: health({ rule: rule({ unverified: false, legal_status: 'VERIFIED' }) }) }) });
      await loaded();
      expect(screen.queryByTestId('freshness-unverified')).toBeNull();
      expect(screen.queryByText(word('egp.connection.freshness.unverified.badge'))).toBeNull();
    });

    it('while the connection is off says that files cannot be applied but the dry run still works', async () => {
      mountWith({ connection: connection({ enabled: false, state_reason: 'Tạm dừng để kiểm tra mẫu tệp', health: health({ apply_blocked: true }) }) });
      await loaded();
      expect(content('freshness-apply-blocked')).toBe(word('egp.connection.freshness.apply.blocked'));
      expect(content('action-disabled')).toContain(word('egp.connection.action.disabled.text'));
      expect(content('status-state')).toContain(word('egp.connection.status.state.disabled'));
      expect(content('status-reason')).toContain('Tạm dừng để kiểm tra mẫu tệp');
    });
  });

  describe('the "i" of a figure', () => {
    it('opens the formula, the source, the moment it is as of and the legal status of the freshness rule, and Escape closes it', async () => {
      mountWith();
      await loaded();
      const name = word('egp.connection.figure.age.name');
      const button = screen.getByRole('button', { name: text('egp.connection.info.open.label', { name }) });
      fireEvent.click(button);
      const panel = screen.getByRole('dialog', { name });
      expect(within(panel).getByText('Độ tuổi = bây giờ − lúc áp dụng tệp gần nhất')).toBeTruthy();
      expect(within(panel).getByText('Dòng file_import của tệp gần nhất')).toBeTruthy();
      expect(within(panel).getByText('08/11/2026')).toBeTruthy();
      expect(within(panel).getByText(/chưa kiểm chứng/)).toBeTruthy();
      expect(within(panel).getByText(word('egp.connection.info.unverified.text'))).toBeTruthy();
      fireEvent.keyDown(panel, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name })).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it('falls back to the words of the screen when the server sends no formula or source, and names the rule of the tenant', async () => {
      mountWith({ connection: connection({ health: health({ rule: rule({ source: 'RULE', version: 3, formula: null, source_text: null, as_of: null, unverified: false, legal_status: null }) }) }) });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: text('egp.connection.info.open.label', { name: word('egp.connection.figure.age.name') }) }));
      const panel = screen.getByRole('dialog', { name: word('egp.connection.figure.age.name') });
      expect(within(panel).getByText(word('egp.connection.figure.age.formula'))).toBeTruthy();
      expect(within(panel).getByText(word('egp.connection.figure.age.source'))).toBeTruthy();
      expect(within(panel).getByText(text('egp.connection.figure.age.version', { version: 3, source: word('egp.connection.figure.rule.tenant'), legal: word('egp.connection.figure.legal.none') }))).toBeTruthy();
      expect(within(panel).queryByText(word('egp.connection.info.unverified.text'))).toBeNull();
    });

    it('gives every computed count its own "i": the records, the open differences and the mappings', async () => {
      mountWith();
      await loaded();
      for (const key of ['egp.connection.figure.records.name', 'egp.connection.figure.differences.name', 'egp.connection.figure.mappings.name'] as const) {
        const name = word(key);
        fireEvent.click(screen.getByRole('button', { name: text('egp.connection.info.open.label', { name }) }));
        const panel = screen.getByRole('dialog', { name });
        expect(within(panel).getByText(word(key.replace('.name', '.formula')))).toBeTruthy();
        expect(within(panel).getByText(word(key.replace('.name', '.source')))).toBeTruthy();
        expect(within(panel).getByText('08/11/2026 10:00')).toBeTruthy();
        fireEvent.click(within(panel).getByRole('button', { name: word('egp.connection.info.close.label') }));
      }
    });
  });

  describe('the numbers, the positions, the layouts and the runs', () => {
    it('shows what the register holds from the network by kind, the open differences and the mappings with a link to BID-23', async () => {
      mountWith();
      await loaded();
      const kind = (code: string): HTMLElement => document.querySelector(`[data-testid="record-counts"] [data-kind="${code}"]`) as HTMLElement;
      expect(kind('KHLCNT').textContent).toContain('1.200');
      expect(kind('TBMT').textContent).toContain('35');
      expect(kind('RESULT').textContent).toContain('0');
      expect(Array.from(document.querySelectorAll('[data-testid="record-counts"] li'))).toHaveLength(5);
      expect(content('mapping-counts')).toContain(`${word('egp.connection.counts.mapping.proposed')}: 2`);
      expect(content('mapping-counts')).toContain(`${word('egp.connection.counts.mapping.active')}: 40`);
      expect(screen.getByRole('link', { name: word('egp.connection.counts.mappings.link') }).getAttribute('href')).toBe('/bid/bid-23');
      expect(screen.getByRole('link', { name: word('egp.connection.counts.differences.link') }).getAttribute('href')).toBe('/bid/bid-24');
    });

    it('lists the five positions with the cursor, the last success and the last error code', async () => {
      mountWith();
      await loaded();
      const row = (kind: string): HTMLElement => document.querySelector(`tr[data-kind="${kind}"]`) as HTMLElement;
      expect(document.querySelectorAll('tr[data-kind]')).toHaveLength(5);
      expect(row('KHLCNT').textContent).toContain('EGP_KHLCNT_FILE');
      expect(row('KHLCNT').textContent).toContain('07/11/2026 08:05');
      expect(row('TBMT').textContent).toContain(word('egp.connection.cursor.failed.name'));
      expect(row('TBMT').textContent).toContain('IMPORT_SCHEMA_INVALID');
      expect(row('RESULT').textContent).toContain(word('egp.connection.cursor.active.name'));
      expect(row('RESULT').textContent).toContain(word('egp.connection.positions.success.none'));
      expect(row('RESULT').textContent).toContain(word('egp.connection.positions.error.none'));
    });

    it('shows the expected columns of each layout, each in its own collapsible group, with the requirement and the allowed values', async () => {
      mountWith();
      await loaded();
      const groups = screen.getAllByTestId('layout');
      expect(groups).toHaveLength(2);
      expect(groups[0]?.tagName).toBe('DETAILS');
      expect(within(groups[0] as HTMLElement).getByText(text('egp.connection.layouts.summary.text', { kind: word('egp.connection.kind.khlcnt.name'), count: 3 }))).toBeTruthy();
      const table = within(groups[0] as HTMLElement);
      expect(table.getByText('khlcnt_code')).toBeTruthy();
      expect(table.getByText('OPEN_BIDDING, LIMITED_BIDDING')).toBeTruthy();
      expect(table.getAllByText(word('egp.connection.layouts.required.row'))).toHaveLength(1);
      expect(table.getAllByText(word('egp.connection.layouts.required.header'))).toHaveLength(1);
      expect(table.getAllByText(word('egp.connection.layouts.required.optional'))).toHaveLength(1);
      expect(table.getByText(word('egp.connection.colkind.money.name'))).toBeTruthy();
      expect(content('layouts-version')).toContain(LAYOUT);
    });

    it('lists the last runs with kind, layout and its PENDING-EXTERNAL word, status, counts, open differences, who and when, and links to BID-24', async () => {
      mountWith();
      await loaded();
      const applied = document.querySelector('tr[data-run-id="00000000-0000-4000-8000-000000000001"]') as HTMLElement;
      expect(applied.textContent).toContain(word('egp.connection.kind.khlcnt.name'));
      expect(applied.textContent).toContain(LAYOUT);
      expect(applied.textContent).toContain(word('egp.connection.acceptance.pending.badge'));
      expect(applied.textContent).toContain(word('egp.connection.runs.applied.name'));
      expect(applied.textContent).toContain(text('egp.connection.runs.counts.text', { total: 12, applied: 9, duplicate: 1, conflict: 1, quarantined: 1 }));
      expect(applied.textContent).toContain('Lê Thị Hoa');
      expect(applied.textContent).toContain('07/11/2026 08:05');
      const failed = document.querySelector('tr[data-run-id="00000000-0000-4000-8000-000000000002"]') as HTMLElement;
      expect(failed.textContent).toContain(word('egp.connection.runs.failed.name'));
      expect(failed.textContent).toContain('IMPORT_SCHEMA_INVALID');
      expect(failed.textContent).toContain(word('egp.connection.runs.by.none'));
      expect(screen.getByRole('link', { name: word('egp.connection.runs.link') }).getAttribute('href')).toBe('/bid/bid-24');
    });

    it('says there is no import yet instead of leaving an empty table', async () => {
      mountWith({ connection: connection({ last_runs: [], history: [] }) });
      await loaded();
      expect(content('runs-empty')).toBe(word('egp.connection.runs.empty.text'));
      expect(content('history-empty')).toBe(word('egp.connection.history.empty.text'));
    });
  });

  describe('what is waiting for an outside party', () => {
    it('lists the eight items with what we wait for, who gives it, the working assumption and what switches, in our language', async () => {
      mountWith();
      await loaded();
      expect(document.querySelectorAll('tr[data-code]')).toHaveLength(pendingItems.length);
      const sample = document.querySelector('tr[data-code="SAMPLE_KHLCNT"]') as HTMLElement;
      expect(sample.textContent).toContain(text('egp.connection.pending.what.sample', { kind: word('egp.connection.kind.khlcnt.name') }));
      expect(sample.textContent).toContain(word('egp.connection.pending.owner.operator'));
      expect(sample.textContent).toContain(text('egp.connection.pending.assumption.layout', { kind: 'KHLCNT', version: LAYOUT }));
      expect(sample.textContent).toContain(word('egp.connection.pending.switches.layout'));
      const api = document.querySelector('tr[data-code="API_SPECIFICATION"]') as HTMLElement;
      expect(api.textContent).toContain(word('egp.connection.pending.what.api'));
      expect(api.textContent).toContain(word('egp.connection.pending.assumption.api'));
      const legal = document.querySelector('tr[data-code="LEGAL_TEXT_DEADLINES"]') as HTMLElement;
      expect(legal.textContent).toContain(word('egp.connection.pending.owner.legal'));
      expect(legal.textContent).toContain(word('egp.connection.pending.switches.legal'));
      expect(document.querySelector('tr[data-code="POSTING_RECEIPT_FORMAT"]')?.textContent).toContain(word('egp.connection.pending.what.receipt'));
      // The words of the server are not shown where ours exist.
      expect(sample.textContent).not.toContain('Official sample of KHLCNT');
    });

    it('shows an item that the server adds later in the words the server sent', async () => {
      mountWith({ connection: connection({ pending_external: [{ code: 'NEW_ITEM', what: 'A new thing', owner: 'Somebody', working_assumption: 'We guess', switches_when_it_arrives: 'It changes' }] }) });
      await loaded();
      const row = document.querySelector('tr[data-code="NEW_ITEM"]') as HTMLElement;
      for (const word of ['A new thing', 'Somebody', 'We guess', 'It changes']) expect(row.textContent).toContain(word);
    });
  });

  it('lists the history of the switch with who, when and why', async () => {
    mountWith();
    await loaded();
    const table = screen.getByRole('region', { name: word('egp.connection.history.caption') });
    expect(within(table).getByText('05/11/2026 09:30')).toBeTruthy();
    expect(within(table).getByText(word('egp.connection.history.enabled.name'))).toBeTruthy();
    expect(within(table).getByText(word('egp.connection.history.created.name'))).toBeTruthy();
    expect(within(table).getAllByText('Nguyễn Văn An')).toHaveLength(1);
    expect(within(table).getAllByText('Bắt đầu nhập tệp thử nghiệm')).toHaveLength(1);
    expect(within(table).getByText(word('egp.connection.history.reason.none'))).toBeTruthy();
  });

  describe('the states', () => {
    it('loading: a skeleton, no number and no button', async () => {
      const state: World = { connection: connection() };
      const h = client(state);
      h.read.mockImplementation(() => new Promise(() => undefined));
      mount(<ConnectionScreen route={route} />, h, { permissions: ADMIN });
      const skeleton = await screen.findByRole('status', { name: base['states.loading.label'] });
      expect(skeleton.getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByTestId('switch-button')).toBeNull();
      expect(screen.queryByTestId('status-card')).toBeNull();
    });

    it('empty: a tenant that never used the connection sees "never imported" and the first-use hint, not an error', async () => {
      mountWith({ connection: unusedConnection() });
      await loaded();
      expect(content('action-first-use')).toContain(word('egp.connection.firstUse.title'));
      expect(content('action-first-use')).toContain(word('egp.connection.firstUse.text'));
      expect(content('status-state')).toContain(word('egp.connection.status.state.unused'));
      expect(content('freshness-status')).toContain('Chưa nhập lần nào');
      expect(content('freshness-alert')).toContain(word('egp.connection.freshness.alert.none'));
      expect(screen.queryByTestId('status-reason')).toBeNull();
      expect(screen.queryByTestId('action-none')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(base['states.error.title'])).toBeNull();
      expect(screen.queryByText(base['states.empty.title'])).toBeNull();
      expect(content('runs-empty')).toBe(word('egp.connection.runs.empty.text'));
      const links = screen.getAllByRole('link', { name: word('egp.connection.action.import.link') });
      expect(links[0]?.getAttribute('href')).toBe('/bid/bid-24');
      // The five positions are there, with no cursor yet.
      expect(document.querySelectorAll('tr[data-kind]')).toHaveLength(5);
      expect(screen.getAllByText(word('egp.connection.cursor.none.name'))).toHaveLength(5);
    });

    it('error: names the failure and retries in place', async () => {
      const { h } = mountWith({ failing: { error: new Error('boom'), times: 1 } });
      expect((await screen.findByRole('alert')).textContent).toContain(base['states.error.title']);
      expect(screen.queryByTestId('status-card')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: base['states.retry.action'] }));
      await loaded();
      expect(h.read).toHaveBeenCalledTimes(2);
    });

    it('forbidden: a refusal of the API says the access is denied and shows nothing of the connection', async () => {
      mountWith({ failing: { error: problem('FORBIDDEN', 403), times: Infinity } });
      expect((await screen.findByRole('alert')).textContent).toContain(base['states.denied.title']);
      expect(screen.queryByTestId('status-card')).toBeNull();
      expect(screen.queryByTestId('switch-button')).toBeNull();
    });

    it('read-only: without the command there is no button, and the screen says why', async () => {
      mountWith({ connection: connection({}, { set_state: false }), permissions: READER });
      await loaded();
      expect(screen.queryByTestId('switch-button')).toBeNull();
      expect(content('readonly-note')).toBe(word('egp.connection.readonly.right.text'));
      // Everything is still readable.
      expect(content('status-code')).toContain('egp.muasamcong');
    });

    it('read-only workspace: no button even when the caller holds the command, and the note names the mode', async () => {
      mountWith({ mode: 'READ_ONLY' });
      await loaded();
      expect(screen.queryByTestId('switch-button')).toBeNull();
      expect(content('readonly-note')).toBe(word('egp.connection.readonly.mode.text'));
    });

    it('a refresh that fails keeps what was read and marks it as old, with the time it was read', async () => {
      const { state } = mountWith({
        command: () => {
          state.failing = { error: new Error('down'), times: Infinity };
          return { operation_id: 'o', status: 'OK', resource_version: 8 };
        },
      });
      await loaded();
      expect(screen.queryByText(/Số liệu cũ/)).toBeNull();
      const button = screen.getByTestId('switch-button');
      fireEvent.click(button);
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Tạm dừng để đổi mẫu tệp' } });
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') }));
      await screen.findByTestId('switch-receipt');
      await screen.findByText(base['ui.contextBar.staleAsOf'].replace('{time}', '08/11/2026 10:00'));
      expect(content('status-code')).toContain('egp.muasamcong');
    });
  });

  describe('turning the connection on and off', () => {
    const open = (): HTMLElement => {
      const button = screen.getByTestId('switch-button');
      button.focus();
      fireEvent.click(button);
      return screen.getByRole('dialog');
    };
    const reason = (dialog: HTMLElement, value: string): void => {
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value } });
    };

    it('offers "Tắt kết nối" while it is on, names the connection and what follows, and asks for a reason', async () => {
      mountWith();
      await loaded();
      expect(screen.getByTestId('switch-button').textContent).toBe(word('egp.connection.header.disable.action'));
      const dialog = open();
      expect(within(dialog).getByRole('heading', { name: word('egp.connection.dialog.disable.title') })).toBeTruthy();
      expect(dialog.textContent).toContain('egp.muasamcong');
      expect(dialog.textContent).toContain(word('egp.connection.dialog.disable.note'));
      expect(within(dialog).getByLabelText(new RegExp(word('egp.connection.dialog.reason.label')))).toBeTruthy();
      expect(within(dialog).getByText(text('egp.connection.dialog.reason.hint', { count: 10 }))).toBeTruthy();
    });

    it('refuses a reason of fewer than ten characters on the screen, before anything is sent', async () => {
      const { h } = mountWith();
      await loaded();
      const dialog = open();
      const confirm = within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') });
      expect(confirm).toHaveProperty('disabled', true);
      reason(dialog, 'too short');
      expect(confirm).toHaveProperty('disabled', true);
      reason(dialog, '   123456789   ');
      expect(confirm).toHaveProperty('disabled', true);
      fireEvent.click(confirm);
      expect(h.command).not.toHaveBeenCalled();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      expect(confirm).toHaveProperty('disabled', false);
    });

    it('sends the switch with the version it saw in If-Match and the reason, then reads the connection again and gives a receipt', async () => {
      const { h, state } = mountWith({
        command: () => {
          state.connection = connection({ enabled: false, version: 8, state_reason: 'Tạm dừng để đổi mẫu tệp', health: health({ apply_blocked: true }) });
          return { operation_id: 'o', status: 'OK', resource_version: 8 };
        },
      });
      await loaded();
      const dialog = open();
      reason(dialog, '  Tạm dừng để đổi mẫu tệp  ');
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command).toHaveBeenCalledWith('setEgpConnectionState', expect.objectContaining({ body: { enabled: false, reason: 'Tạm dừng để đổi mẫu tệp' }, ifMatchVersion: 7 }));
      const receipt = await screen.findByTestId('switch-receipt');
      expect(receipt.getAttribute('role')).toBe('status');
      expect(receipt.textContent).toContain('egp.muasamcong');
      expect(receipt.textContent).toContain(word('egp.connection.success.disabled.text').split('{time}')[1] ?? '');
      // The screen shows the state the server now holds, and the offer is the opposite one.
      await waitFor(() => expect(content('status-state')).toContain(word('egp.connection.status.state.disabled')));
      expect(content('freshness-apply-blocked')).toBe(word('egp.connection.freshness.apply.blocked'));
      expect(content('status-reason')).toContain('Tạm dừng để đổi mẫu tệp');
      expect(screen.getByTestId('switch-button').textContent).toBe(word('egp.connection.header.enable.action'));
      expect(h.read.mock.calls.filter((call) => call[0] === 'getEgpConnection').length).toBeGreaterThanOrEqual(2);
    });

    it('turns it on again under the new version, with its own wording', async () => {
      const { h } = mountWith({ connection: connection({ enabled: false, version: 8, state_reason: 'Tạm dừng', health: health({ apply_blocked: true }) }) });
      await loaded();
      expect(screen.getByTestId('switch-button').textContent).toBe(word('egp.connection.header.enable.action'));
      const dialog = open();
      expect(within(dialog).getByRole('heading', { name: word('egp.connection.dialog.enable.title') })).toBeTruthy();
      expect(dialog.textContent).toContain(word('egp.connection.dialog.enable.note'));
      reason(dialog, 'Mẫu tệp đã được rà soát xong');
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.enable.confirm') }));
      await screen.findByTestId('switch-receipt');
      expect(h.command).toHaveBeenCalledWith('setEgpConnectionState', expect.objectContaining({ body: { enabled: true, reason: 'Mẫu tệp đã được rà soát xong' }, ifMatchVersion: 8 }));
      expect(content('switch-receipt')).toContain(word('egp.connection.success.enabled.text').split('{time}')[1] ?? '');
    });

    it('sends once when the button is pressed twice before the answer', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const { h } = mountWith({ command: () => pending });
      await loaded();
      const dialog = open();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      const confirm = within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      fireEvent.click(confirm);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.command).toHaveBeenCalledTimes(1);
      release({ operation_id: 'o', status: 'OK', resource_version: 8 });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('conflict: says someone changed the connection, offers a reload that reads it again and closes the dialog', async () => {
      const { h, state } = mountWith({ command: () => problem('VERSION_CONFLICT', 409) });
      await loaded();
      const dialog = open();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') }));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toBe(word('egp.connection.error.conflict.text'));
      state.connection = connection({ enabled: false, version: 9, state_reason: 'Do người khác tắt' });
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.reload.action') }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(content('status-reason')).toContain('Do người khác tắt'));
      expect(screen.queryByTestId('switch-receipt')).toBeNull();
      expect(h.read.mock.calls.filter((call) => call[0] === 'getEgpConnection').length).toBeGreaterThanOrEqual(2);
    });

    it('validation: shows the field the server names, inside the dialog', async () => {
      mountWith({ command: () => problem('VALIDATION_FAILED', 422, 'reason') });
      await loaded();
      const dialog = open();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(text('egp.connection.error.validation.text', { detail: 'reason' }));
      expect(screen.queryByTestId('switch-receipt')).toBeNull();
      // The dialog stays open with the person's reason: it can be corrected and sent again.
      expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Tạm dừng để đổi mẫu tệp');
    });

    it('forbidden: a refusal of the command says the right is missing, and the screen is unchanged', async () => {
      mountWith({ command: () => problem('FORBIDDEN', 403) });
      await loaded();
      const dialog = open();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      fireEvent.click(within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(word('egp.connection.error.forbidden.text'));
      expect(content('status-state')).toContain(word('egp.connection.status.state.enabled'));
    });

    it('any other failure says it could not be done and can be sent again', async () => {
      let calls = 0;
      const { h } = mountWith({
        command: () => {
          calls += 1;
          return calls === 1 ? new Error('network') : { operation_id: 'o', status: 'OK', resource_version: 8 };
        },
      });
      await loaded();
      const dialog = open();
      reason(dialog, 'Tạm dừng để đổi mẫu tệp');
      const confirm = within(dialog).getByRole('button', { name: word('egp.connection.dialog.disable.confirm') });
      fireEvent.click(confirm);
      expect((await within(dialog).findByRole('alert')).textContent).toBe(word('egp.connection.error.unknown.text'));
      fireEvent.click(confirm);
      await screen.findByTestId('switch-receipt');
      expect(h.command).toHaveBeenCalledTimes(2);
    });

    it('a dialog that is cancelled sends nothing and gives the focus back to the button', async () => {
      const { h } = mountWith();
      await loaded();
      const button = screen.getByTestId('switch-button');
      const dialog = open();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(h.command).not.toHaveBeenCalled();
      expect(screen.queryByTestId('switch-receipt')).toBeNull();
    });
  });

  describe('language and the part files', () => {
    it('speaks English when the language is English', async () => {
      translator.setLocale('en');
      mountWith({ connection: connection({ health: staleHealth() }) });
      await loaded();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(wordEn('egp.connection.page.title'));
      expect(content('freshness-status')).toContain(wordEn('egp.connection.freshness.state.stale'));
      expect(content('freshness-alert')).toContain(wordEn('egp.connection.severity.watch.name'));
      expect(content('status-layout')).toContain(wordEn('egp.connection.status.layout.pending'));
    });

    it('holds the same keys of egp.connection. in both languages, with the same placeholders and a real English text', () => {
      const keys = (source: object): string[] => Object.keys(source).filter((key) => key.startsWith('egp.connection.')).sort();
      const viKeys = keys(base);
      expect(viKeys.length).toBeGreaterThan(200);
      expect(keys(en)).toEqual(viKeys);
      const placeholders = (value: string): string[] => (value.match(/\{\w+\}/g) ?? []).sort();
      for (const key of viKeys) {
        expect(placeholders(wordEn(key))).toEqual(placeholders(word(key)));
        expect(wordEn(key).trim()).not.toBe('');
        // The English text is English: it holds no Vietnamese letter that only Vietnamese uses.
        expect(wordEn(key)).not.toMatch(/[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]/u);
      }
    });
  });
});
