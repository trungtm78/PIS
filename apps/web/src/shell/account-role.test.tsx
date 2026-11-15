import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../i18n';
import vi_ from '../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { SessionContext } from '../session/SessionContext';
import type { SessionValue } from '../session/SessionContext';
import { SignedOutPage } from '../session/oidc/SignedOutPage';
import { highestRoleLabel } from './account-role';

const words = translator.t;
const grant = (roleCode: string, rank: number, roleName = `iam.role.${roleCode}.name`, state = 'ACTIVE') => ({ roleCode, roleName, rank, state });

afterEach(cleanup);

describe('the role under the name of the person', () => {
  it('is the highest role in force: the words of the catalogue for a system role, the name of the organisation for its own role', () => {
    expect(highestRoleLabel([grant('MEMBER', 10), grant('TENANT_OWNER', 99)], words)).toBe('Quản trị cao nhất');
    expect(highestRoleLabel([grant('LEADER', 60), grant('LANH_DAO_SO', 65, 'Lãnh đạo đơn vị'), grant('STAFF_MEMBER', 15)], words)).toBe('Lãnh đạo đơn vị');
    // A role made in several parts shows one name.
    expect(highestRoleLabel([grant('CAN_BO_BAN_QLDA_2', 45, 'Cán bộ Ban quản lý dự án (phần 2)'), grant('MEMBER', 10)], words)).toBe('Cán bộ Ban quản lý dự án');
    expect(highestRoleLabel([grant('STAFF_MEMBER', 15), grant('MEMBER', 10)], words)).toBe('Cán bộ, nhân viên');
  });

  it('does not count a role that is not in force, and says nothing when there is none or the name is only a code', () => {
    expect(highestRoleLabel([grant('TENANT_OWNER', 99, undefined, 'EXPIRED'), grant('MEMBER', 10)], words)).toBe('Thành viên');
    expect(highestRoleLabel([], words)).toBeUndefined();
    expect(highestRoleLabel([grant('X_ROLE', 30, 'X_ROLE')], words)).toBeUndefined();
    expect(highestRoleLabel([grant('SOME_SYSTEM', 30)], words)).toBeUndefined();
  });
});

describe('the page of a person who signed out', () => {
  it('says "Bạn đã đăng xuất", offers the sign-in and shows nothing of the application', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    const session = { tenant: undefined, tenants: [], user: undefined, access: ALL_MODULES_VISIBLE, switchTenant: vi.fn(), getSession: () => Promise.resolve(undefined), signIn } as unknown as SessionValue;
    render(
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={['/auth/signed-out']}>
          <SignedOutPage />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    expect(screen.getByRole('heading', { name: 'Bạn đã đăng xuất' })).toBeInTheDocument();
    expect(screen.queryByText(vi_['states.signedOut.title'])).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/' });
  });
});
