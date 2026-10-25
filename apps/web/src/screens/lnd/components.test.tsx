import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { NoticeDialog, ParcelDialog, SectionDialog } from './components';
import { toParcelLine } from './model';
import type { ParcelLine } from './model';
import { CONTRACT, DOCUMENT, PROJECT, SECTION, UNIT_TTQD, UNIT_XA, client, mount, parcel, world } from './test-support';

const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OK = { operation_id: 'o', status: 'SURVEYED', resource_version: 2, resource_id: 'x' };
const UNITS = [
  { id: UNIT_XA, code: 'XA1', name: 'UBND xã An Phú' },
  { id: UNIT_TTQD, code: 'TTQD', name: 'Trung tâm phát triển quỹ đất' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
};

describe('NoticeDialog (the notice of recovery of a parcel, AC-ST-LND-001-1)', () => {
  const target = (overrides: Record<string, unknown> = {}): ParcelLine => toParcelLine(parcel(1, overrides)) as ParcelLine;
  const open = (command: (operation: string, input: unknown) => unknown, onClose = vi.fn(), subject = target()) => {
    const h = client(world(), command);
    mount(<NoticeDialog parcel={subject} today="2026-10-24" onClose={onClose} />, h, { permissions: ['land.process'] });
    return { h, onClose };
  };

  it('says which timer the notice will start, and sends the date and the document under the version of the parcel', async () => {
    const { h, onClose } = open(() => OK);
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).not.toBeNull();
    expect(screen.getByTestId('notice-timer').textContent).toBe(vi_['lnd.noticeDialog.timer.text'].replace('{timer}', vi_['lnd.timer.noticeAgricultural90.label']));
    save();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([vi_['lnd.field.required.error'], vi_['lnd.field.required.error']]);
    fill(vi_['lnd.noticeDialog.date.label'], '2026-07-01');
    fill(vi_['lnd.noticeDialog.document.label'], DOCUMENT.toUpperCase());
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('recordRecoveryNotice', expect.objectContaining({ path: { id: parcel(1).id }, ifMatchVersion: 1, body: { notice_on: '2026-07-01', notice_document_version_id: DOCUMENT } }));
  });

  it('names the long timer for land that is not agricultural, and refuses a date that has not come', () => {
    open(() => OK, vi.fn(), target({ land_use_group: 'PUBLIC' }));
    expect(screen.getByTestId('notice-timer').textContent).toContain(vi_['lnd.timer.noticeNonAgricultural180.label']);
    fill(vi_['lnd.noticeDialog.date.label'], '2026-10-25');
    fill(vi_['lnd.noticeDialog.document.label'], DOCUMENT);
    save();
    expect(screen.getByRole('alert').textContent).toBe(vi_['lnd.field.future.error']);
  });

  it('shows the refusal of the server in words, keeps the dialog open and lets the officer close it', async () => {
    const { h, onClose } = open(() => {
      throw problem('TIMER_RULE_UNCONFIRMED');
    });
    fill(vi_['lnd.noticeDialog.date.label'], '2024-12-31');
    fill(vi_['lnd.noticeDialog.document.label'], DOCUMENT);
    save();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.ruleUnconfirmed.error']);
    expect(onClose).not.toHaveBeenCalled();
    expect(h.command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.dialog.cancel.action'] }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on the close button and on Escape', () => {
    const { onClose } = open(() => OK);
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.dialog.close.label'] }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ParcelDialog (the declaration of a parcel, AC-ST-LND-001-2)', () => {
  const open = (command: (operation: string, input: unknown) => unknown = () => OK, onClose = vi.fn()) => {
    const h = client(world(), command);
    mount(<ParcelDialog projectId={PROJECT} units={UNITS} sections={[{ id: SECTION, code: 'KM-0-3', name: 'Km 0 đến km 3' }]} onClose={onClose} />, h, { permissions: ['land.manage'] });
    return { h, onClose };
  };

  it('has no field for an owner or a user of the land, and tells the officer not to write one in the address', () => {
    open();
    const labels = Array.from(document.querySelectorAll('label')).map((label) => label.textContent ?? '');
    expect(labels).toEqual([
      vi_['lnd.parcelDialog.code.label'],
      vi_['lnd.parcelDialog.unit.label'],
      vi_['lnd.parcelDialog.landUse.label'],
      vi_['lnd.parcelDialog.areaTotal.label'],
      vi_['lnd.parcelDialog.areaAffected.label'],
      vi_['lnd.parcelDialog.address.label'],
      vi_['lnd.parcelDialog.section.label'],
    ]);
    expect(screen.getByLabelText(vi_['lnd.parcelDialog.address.label']).getAttribute('aria-describedby')).toContain('hint');
    expect(document.body.textContent).toContain(vi_['lnd.parcelDialog.address.help']);
  });

  it('checks the form before it sends anything, then sends the parcel with the code in capitals', async () => {
    const { h, onClose } = open();
    save();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBe(5);
    fill(vi_['lnd.parcelDialog.code.label'], ' tb-12/345 ');
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcelDialog.unit.label']), { target: { value: UNIT_TTQD } });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcelDialog.landUse.label']), { target: { value: 'NON_AGRICULTURAL_RESIDENTIAL' } });
    fill(vi_['lnd.parcelDialog.areaTotal.label'], '300');
    fill(vi_['lnd.parcelDialog.areaAffected.label'], '400');
    save();
    expect(screen.getByRole('alert').textContent).toBe(vi_['lnd.field.invalid.error']);
    fill(vi_['lnd.parcelDialog.areaAffected.label'], '300');
    fill(vi_['lnd.parcelDialog.address.label'], 'Thôn 3');
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcelDialog.section.label']), { target: { value: SECTION } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith(
      'createLandParcel',
      expect.objectContaining({
        body: { project_id: PROJECT, owner_unit_id: UNIT_TTQD, parcel_code: 'TB-12/345', land_use_group: 'NON_AGRICULTURAL_RESIDENTIAL', area_total_m2: '300', area_affected_m2: '300', address_text: 'Thôn 3', section_id: SECTION },
      }),
    );
  });

  it('shows a duplicate code in words, and the dialog stays open', async () => {
    const { onClose } = open(() => {
      throw problem('PARCEL_CODE_DUPLICATE', 409);
    });
    fill(vi_['lnd.parcelDialog.code.label'], 'TB-1');
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcelDialog.unit.label']), { target: { value: UNIT_XA } });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcelDialog.landUse.label']), { target: { value: 'AGRICULTURAL' } });
    fill(vi_['lnd.parcelDialog.areaTotal.label'], '10');
    fill(vi_['lnd.parcelDialog.areaAffected.label'], '5');
    save();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.codeDuplicate.error']);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SectionDialog (the creation of a handover section)', () => {
  const open = (command: (operation: string, input: unknown) => unknown = () => OK, onClose = vi.fn()) => {
    const h = client(world(), command);
    mount(<SectionDialog projectId={PROJECT} onClose={onClose} />, h, { permissions: ['land.manage'] });
    return { h, onClose };
  };

  it('sends the section with its kilometres and its area', async () => {
    const { h, onClose } = open();
    save();
    expect(h.command).not.toHaveBeenCalled();
    expect(within(screen.getByRole('dialog')).getAllByRole('alert').length).toBe(3);
    fill(vi_['lnd.sectionDialog.code.label'], 'KM-0-3');
    fill(vi_['lnd.sectionDialog.name.label'], 'Km 0 đến km 3');
    fill(vi_['lnd.sectionDialog.fromKm.label'], '0');
    fill(vi_['lnd.sectionDialog.toKm.label'], '3');
    fill(vi_['lnd.sectionDialog.area.label'], '30000');
    fill(vi_['lnd.sectionDialog.target.label'], '2027-03-01');
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith(
      'createLandSection',
      expect.objectContaining({ body: { project_id: PROJECT, code: 'KM-0-3', name: 'Km 0 đến km 3', required_area_m2: '30000', from_km: '0', to_km: '3', target_date: '2027-03-01' } }),
    );
  });

  it('offers the contracts of the project as the one that receives the land, and sends the one that is chosen', async () => {
    const h = client(world(), () => OK);
    const onClose = vi.fn();
    mount(<SectionDialog projectId={PROJECT} contracts={[{ id: CONTRACT, code: 'HD-A-001', projectId: PROJECT }]} onClose={onClose} />, h, { permissions: ['land.manage'] });
    const select = screen.getByLabelText(vi_['lnd.sectionDialog.contract.label']) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['lnd.sectionDialog.contract.none'], 'HD-A-001']);
    fill(vi_['lnd.sectionDialog.code.label'], 'KM-0-3');
    fill(vi_['lnd.sectionDialog.name.label'], 'Km 0 đến km 3');
    fill(vi_['lnd.sectionDialog.area.label'], '30000');
    fireEvent.change(select, { target: { value: CONTRACT } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('createLandSection', expect.objectContaining({ body: expect.objectContaining({ contract_id: CONTRACT }) }));
  });

  it('does not offer a contract when the project has none the caller can read', () => {
    open();
    expect(screen.queryByLabelText(vi_['lnd.sectionDialog.contract.label'])).toBeNull();
  });

  it('shows a refusal of the server and does not send twice while it is sending', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const h = client(world(), () => slow);
    const onClose = vi.fn();
    mount(<SectionDialog projectId={PROJECT} onClose={onClose} />, h, { permissions: ['land.manage'] });
    fill(vi_['lnd.sectionDialog.code.label'], 'KM-1');
    fill(vi_['lnd.sectionDialog.name.label'], 'Km 1');
    fill(vi_['lnd.sectionDialog.area.label'], '10');
    save();
    await screen.findByText(vi_['lnd.dialog.submit.pending']);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    expect(h.command).toHaveBeenCalledTimes(1);
    release(OK);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('answers an unknown failure with the general sentence', async () => {
    open(() => {
      throw new Error('network');
    });
    fill(vi_['lnd.sectionDialog.code.label'], 'KM-1');
    fill(vi_['lnd.sectionDialog.name.label'], 'Km 1');
    fill(vi_['lnd.sectionDialog.area.label'], '10');
    save();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.general.error']);
  });
});
