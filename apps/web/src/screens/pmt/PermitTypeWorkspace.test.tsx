import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import { PermitTypeWorkspace } from './PermitTypeWorkspace';
import { toPermitType } from './model';
import type { PermitTypeView } from './model';
import { MANAGER, READER, client, permitType } from './test-support';

const TODAY = '2026-08-01';
const views = (rows: Array<Record<string, unknown>>): PermitTypeView[] => rows.flatMap((row) => toPermitType(row) ?? []);

afterEach(cleanup);

const mount = (rows: Array<Record<string, unknown>>, options: Parameters<typeof mountInSession>[2] = { permissions: MANAGER }) =>
  mountInSession(<PermitTypeWorkspace types={views(rows)} today={TODAY} />, client(), options);

describe('PermitTypeWorkspace (PMT-03): the catalogue of permit types as dated legal data', () => {
  it('shows the catalogue with the form to publish and the way to end a version, for the one who manages it', () => {
    mount([permitType(1), permitType(2)]);
    expect(screen.getByRole('table', { name: vi_['pmt.type.table.aria'] })).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: vi_['pmt.type.retire.action'] })).toHaveLength(2);
    expect(screen.queryByTestId('unconfirmed-banner')).toBeNull();
  });

  it('says how many versions are working assumptions, and counts none whose last day has passed (AC-ST-PMT-001-1)', () => {
    mount([permitType(1, { cxn_ref: 'CXN-EXE-03' }), permitType(2, { cxn_ref: 'CXN-EXE-02', effective_from: '2026-09-01' }), permitType(3, { cxn_ref: 'CXN-EXE-03', status: 'RETIRED', effective_until: '2026-03-31' })]);
    expect(screen.getByTestId('unconfirmed-banner').textContent).toBe(vi_['pmt.type.unconfirmed.banner'].replace('{count}', '2'));
  });

  it('says so when the catalogue is empty, and still offers the form', () => {
    mount([]);
    expect(screen.getByTestId('empty-catalogue').textContent).toBe(vi_['pmt.type.empty.text']);
    expect(screen.queryByRole('table', { name: vi_['pmt.type.table.aria'] })).toBeNull();
    expect(screen.getByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeTruthy();
  });

  it('shows the catalogue and nothing to change to someone who may only read it', () => {
    mount([permitType(1)], { permissions: READER });
    expect(screen.getByRole('table', { name: vi_['pmt.type.table.aria'] })).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pmt.type.retire.action'] })).toBeNull();
    expect(screen.getByText(vi_['pmt.type.readonly.text'])).toBeTruthy();
  });

  it('shows nothing to change while the tenant is suspended, whatever the grants say', () => {
    mount([permitType(1)], { permissions: MANAGER, mode: 'READ_ONLY' });
    expect(screen.queryByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pmt.type.retire.action'] })).toBeNull();
  });

  it('treats unknown permissions as able to manage, as the other screens do: the server still decides', () => {
    mount([permitType(1)], { permissions: undefined });
    expect(screen.getByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeTruthy();
  });

  it('reads the day from the clock when none is given', () => {
    mountInSession(<PermitTypeWorkspace types={views([permitType(1, { effective_from: '2000-01-01' })])} />, client(), { permissions: MANAGER });
    expect(document.querySelector('tr[data-group-code]')?.getAttribute('data-phase')).toBe('inForce');
  });
});
