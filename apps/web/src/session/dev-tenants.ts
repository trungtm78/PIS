import data from './dev-session.json';
import type { SessionTenant, SessionUser } from './SessionContext';

/**
 * Appears in the development session module only; the production bundle test searches the build output for it,
 * so it must never be exported from, or inlined into, a module the production entry imports.
 */
export const DEV_SESSION_MARKER = 'mv-dev-session-provider-7f3a';

const FIXTURE_MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';

/** Two fixture tenants (TNT-A and TNT-B of test_fixtures.json) with different published themes; the names are data in dev-session.json. */
export const DEV_TENANTS: readonly SessionTenant[] = [
  {
    ...data.tenants[0]!,
    membershipId: FIXTURE_MEMBERSHIP,
    theme: { themeId: 'theme-cao-bang', version: 2, overlay: { primary: '#007D77', primaryText: '#FFFFFF' } },
  },
  {
    ...data.tenants[1]!,
    membershipId: FIXTURE_MEMBERSHIP,
    theme: { themeId: 'theme-lao-cai', version: 5, overlay: { primary: '#0B5CAD', primaryText: '#FFFFFF' } },
  },
];

/** The platform pseudo-tenant a control-plane user signs in on (the control plane has no tenant of its own); its theme is the base theme. The development fixture shows it with the prototype sample workspace name, so the shell frame equals the mockups of the control-plane screens. */
export const PLATFORM_TENANT: Omit<SessionTenant, 'membershipId'> = {
  ...data.platform,
  theme: { themeId: 'platform', version: 1, overlay: {} },
};

/** The development user starts with three unread notifications, as the mockup shows. */
export const DEV_USER: SessionUser = { ...data.user, unreadNotifications: 3 };

/**
 * The tenants of the development session for an address query: one tenant by default (so the sidebar matches the
 * mockup), both fixture tenants with `?tenants=2` for the tenant-switch flows.
 */
export function devTenantsFor(search: string): readonly SessionTenant[] {
  const both = new URLSearchParams(search).get('tenants') === '2';
  return both ? DEV_TENANTS : DEV_TENANTS.slice(0, 1);
}
