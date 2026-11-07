import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { DossierTable } from './DossierTable';
import { toDossierLine } from './dossier-model';
import type { DossierLineView } from './dossier-model';
import { OFFICER, client, dossierId, dossierLine, mount, world } from './dossier-test-support';

afterEach(cleanup);

const lines = (...rows: Array<Record<string, unknown>>): DossierLineView[] => rows.flatMap((row) => toDossierLine(row) ?? []);
const show = (dossiers: DossierLineView[], selectedId?: string, onSelect: (id: string) => void = () => undefined) =>
  mount(<DossierTable dossiers={dossiers} selectedId={selectedId} onSelect={onSelect} />, client(world()), { permissions: OFFICER });
// A dossier is the row of the table of the kit that holds the cell carrying its id.
const row = (n: number): HTMLElement => document.querySelector(`[data-dossier-id="${dossierId(n)}"]`)?.closest('tr') as HTMLElement;

describe('DossierTable (PMT-01): the legal dossier of each project', () => {
  it('shows each project with how many required types are covered, the readiness as a number and a bar, and the permits that end soon (UI-PMT-01)', () => {
    show(lines(dossierLine(1, { expiring_count: 2 }), dossierLine(2, { status: 'COMPLETE', readiness_pct: '100.00', required_count: 3, satisfied_count: 3, issued_count: 3 })));
    expect(screen.getByRole('table', { name: vi_['pmt.dossier.table.aria'] })).toBeTruthy();
    const first = within(row(1));
    expect(first.getByText('DA-2026-001')).toBeTruthy();
    expect(first.getByText('Dự án số 1')).toBeTruthy();
    expect(first.getByText(vi_['pmt.dossier.required.text'].replace('{satisfied}', '1').replace('{required}', '2'))).toBeTruthy();
    expect(first.getByText(vi_['pmt.dossier.readiness.text'].replace('{pct}', '50.00'))).toBeTruthy();
    expect((first.getByRole('progressbar') as HTMLProgressElement).value).toBe(50);
    expect(first.getByText('2').closest('.ui-pill')?.className).toContain('ui-tone-warning');
    expect(first.getByText(vi_['pmt.dossier.status.open.text'])).toBeTruthy();
    expect(within(row(2)).getByText(vi_['pmt.dossier.status.complete.text']).closest('.ui-pill')?.className).toContain('ui-tone-success');
  });

  it('flags a dossier whose types still wait for their legal confirmation, and shows the person in charge or else the unit', () => {
    show(lines(dossierLine(1, { unconfirmed_count: 2, owner_membership: { membership_id: 'm1', display_name: 'Nguyễn Văn A' } }), dossierLine(2, { project_component_code: 'HP1' })));
    expect(within(row(1)).getByTestId('unconfirmed').textContent).toBe(vi_['pmt.dossier.unconfirmed.text'].replace('{count}', '2'));
    expect(within(row(1)).getByText('Nguyễn Văn A')).toBeTruthy();
    expect(within(row(2)).queryByTestId('unconfirmed')).toBeNull();
    expect(within(row(2)).getByText('Ban QLDA tỉnh')).toBeTruthy();
    expect(within(row(2)).getByText(vi_['pmt.dossier.component.text'].replace('{code}', 'HP1'))).toBeTruthy();
  });

  it('keeps the bar inside 0 to 100 and marks the selected dossier', async () => {
    const onSelect = vi.fn();
    show(lines(dossierLine(1, { readiness_pct: '140.00' }), dossierLine(2)), dossierId(2), onSelect);
    expect((within(row(1)).getByRole('progressbar') as HTMLProgressElement).value).toBe(100);
    expect(row(2).querySelector('[data-selected]')?.getAttribute('data-selected')).toBe('true');
    expect(within(row(2)).getByRole('button', { name: vi_['pmt.dossier.select.action'] }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.setup().click(within(row(1)).getByRole('button', { name: vi_['pmt.dossier.select.action'] }));
    expect(onSelect).toHaveBeenCalledWith(dossierId(1));
  });
});
