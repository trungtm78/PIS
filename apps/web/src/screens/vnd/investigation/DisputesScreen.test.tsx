import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import DisputesScreen from './DisputesScreen';
import { AUDITOR, CONTRACTOR, READER, client, disputes, mount, ocds, routeOf, uuid } from './test/investigation-fixtures';
import type { World } from './test/investigation-fixtures';
import { problem, text, word } from './test/helpers';

const route = routeOf('VND-22', 'FR-VND-22');

const downloads: Array<{ name: string; blob: Blob }> = [];

const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

beforeEach(() => {
  downloads.length = 0;
  let last: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      last = blob;
      return 'blob:test';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: last as Blob });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  path?: string;
  failing?: World['failing'];
  export?: unknown;
}

function open(answer: Record<string, unknown> = disputes(), options: Options = {}) {
  const world: World = { answers: { getVendorDisputes: answer, exportVendorOcdsParties: options.export ?? ocds() }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world);
  mount(<DisputesScreen route={route} />, h, { permissions: options.permissions ?? AUDITOR, path: options.path ?? '/vnd/vnd-22' });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('dispute-cards');
};

describe('DisputesScreen (VND-22): disputes and the OCDS export', () => {
  it('counts the petitions, the claims and the whole register, each with its shares and its "i"', async () => {
    open();
    await loaded();
    expect(screen.queryByTestId('dispute-card-contractor')).toBeNull();
    expect(screen.getByTestId('petitions-total').textContent).toBe('3');
    expect(screen.getByTestId('claims-total').textContent).toBe('1');
    expect(screen.getByTestId('portfolio-total').textContent).toBe('9');
    expect(screen.getByTestId('portfolio-upheld-pct').textContent).toBe('40%');
    expect(screen.getByTestId('petitions-days').textContent).toBe(text('vnd3.disputes.fact.days.text', { days: '6,5' }));
    expect(screen.getByTestId('petitions-decided').textContent).toBe(text('vnd3.disputes.fact.decided.text', { upheld: 1, rejected: 2, withdrawn: 0 }));
    const card = within(screen.getByTestId('dispute-card-petitions'));
    fireEvent.click(card.getAllByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.disputes.fact.upheld.label') }) })[0] as HTMLElement);
    expect(screen.getByText(word('vnd3.disputes.fact.upheld.formula'))).toBeTruthy();
  });

  it('says none, not zero, for a share and a mean that have nothing to divide', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('claims-upheld-pct').textContent).toBe('–');
    expect(screen.getByTestId('claims-days').textContent).toBe('–');
  });

  it('adds the card of the contractor when the address names one, and asks the server for that contractor', async () => {
    const { h } = open(disputes(), { path: `/vnd/vnd-22?contractor=${CONTRACTOR}` });
    await screen.findByTestId('dispute-card-contractor');
    expect(h.read).toHaveBeenCalledWith('getVendorDisputes', { query: { contractor_id: CONTRACTOR } });
    expect(screen.getByRole('link', { name: word('vnd3.disputes.profile.link') }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
  });

  it('ignores an address that is not an id of a contractor', async () => {
    const { h } = open(disputes(), { path: '/vnd/vnd-22?contractor=nope' });
    await loaded();
    expect(h.read).toHaveBeenCalledWith('getVendorDisputes', { query: {} });
  });

  it('lists the petitions and the claims with the outcome and the days', async () => {
    open();
    await loaded();
    const [petition, claim] = Array.from(document.querySelectorAll<HTMLElement>('tr[data-dispute-id]'));
    expect(petition?.textContent).toContain(word('vnd3.disputeKind.petition.name'));
    expect(petition?.textContent).toContain('GT-2026-01');
    expect(petition?.textContent).toContain(word('vnd3.disputeOutcome.upheld.name'));
    expect(petition?.textContent).toContain('01/09/2026');
    expect(petition?.textContent).toContain('10/09/2026');
    expect(within(petition as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(claim?.textContent).toContain(word('vnd3.disputeKind.claim.name'));
    expect(claim?.textContent).toContain(word('vnd3.disputeOutcome.open.name'));
  });

  describe('the export of parties', () => {
    it('tells that the owners and the contact point are left out unless the rule allows them, before anything is downloaded', async () => {
      open();
      await loaded();
      expect(screen.getByTestId('ocds-notice').textContent).toBe(word('vnd3.ocds.notice.text'));
      expect(screen.getByTestId('ocds-none').textContent).toBe(word('vnd3.ocds.none.text'));
    });

    it('downloads the file with the parties only and says what it holds, with the rule', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('download-ocds'));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('exportVendorOcdsParties', { query: {} }));
      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]?.name).toBe('ocds-parties-2026-11-08.json');
      const content = JSON.parse(await readBlob(downloads[0]?.blob as Blob)) as { parties: Array<{ id: string }> };
      expect(Object.keys(content)).toEqual(['parties']);
      expect(content.parties[0]?.id).toBe('VN-MST-0101234561');
      const result = await screen.findByTestId('ocds-result');
      expect(result.textContent).toContain(text('vnd3.ocds.result.text', { count: 1, owners: word('vnd3.ocds.flag.excluded'), contact: word('vnd3.ocds.flag.excluded') }));
      expect((await screen.findByTestId('receipt')).textContent).toContain('1');
      fireEvent.click(within(result).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.ocds.policy.name') }) }));
      expect(screen.getByText('Formula of VENDOR_OCDS_EXPORT')).toBeTruthy();
    });

    it('says that the owners are in the file when the rule allowed them', async () => {
      open(disputes(), { export: ocds({ owners_included: true }) });
      await loaded();
      fireEvent.click(screen.getByTestId('download-ocds'));
      expect((await screen.findByTestId('ocds-result')).textContent).toContain(text('vnd3.ocds.result.text', { count: 1, owners: word('vnd3.ocds.flag.included'), contact: word('vnd3.ocds.flag.excluded') }));
    });

    it('asks for one package, and keeps the button off when the id is not an id; asks for the contractor of the address', async () => {
      const { h } = open(disputes(), { path: `/vnd/vnd-22?contractor=${CONTRACTOR}` });
      await loaded();
      const field = screen.getByLabelText(word('vnd3.ocds.field.package.label'));
      fireEvent.change(field, { target: { value: 'nope' } });
      expect((screen.getByTestId('download-ocds') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(field, { target: { value: uuid('0300', 1) } });
      fireEvent.click(screen.getByTestId('download-ocds'));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('exportVendorOcdsParties', { query: { contractor_id: CONTRACTOR, package_id: uuid('0300', 1) } }));
    });

    it('says a refused export in place and downloads nothing', async () => {
      open(disputes(), { failing: { exportVendorOcdsParties: { error: problem(403, 'SCOPE_DENIED'), times: 1 } } });
      await loaded();
      fireEvent.click(screen.getByTestId('download-ocds'));
      expect((await screen.findByTestId('ocds-error')).textContent).toBe(word('vnd.error.forbidden.text'));
      expect(downloads).toHaveLength(0);
    });

    it('is not offered without the right to export', async () => {
      open(disputes(), { permissions: READER });
      await loaded();
      expect(screen.queryByTestId('download-ocds')).toBeNull();
      expect(screen.queryByTestId('ocds-notice')).toBeNull();
    });
  });

  describe('states', () => {
    it('EMPTY: says there is no dispute and still shows the counts', async () => {
      open(disputes({ items: [] }));
      await loaded();
      expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    });

    it('LOADING, ERROR with a retry, FORBIDDEN', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<DisputesScreen route={route} />, pending, { permissions: AUDITOR, path: '/vnd/vnd-22' });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open(disputes(), { failing: { getVendorDisputes: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
      cleanup();
      open(disputes(), { failing: { getVendorDisputes: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    });
  });

  it('speaks English when the language is English', async () => {
    translator.setLocale('en');
    open();
    await loaded();
    expect(screen.getByTestId('dispute-card-petitions')).toBeTruthy();
    expect(screen.getByTestId('ocds-notice').textContent).toContain('tax code');
  });
});
