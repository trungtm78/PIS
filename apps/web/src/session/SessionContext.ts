import { createContext, useContext } from 'react';
import type { components } from '@machvon/contracts';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import type { NavigationAccess } from '../navigation/model';
import type { TenantThemeSpec } from '../theme/ThemeProvider';

/** A tenant the signed-in user holds a membership in, as the shell needs it. */
export interface SessionTenant {
  id: string;
  name: string;
  /** Two letters in the round tenant mark of the sidebar. */
  monogram: string;
  membershipId: string;
  theme: TenantThemeSpec;
}

export interface SessionUser {
  displayName: string;
  initials: string;
  /** Unread notifications shown as the badge next to the notifications link; absent or 0 shows no badge. */
  unreadNotifications?: number;
}

/** How strongly the session is authenticated; step-up commands need `aal2` within the last 15 minutes. */
export interface SessionAssurance {
  level: 'aal1' | 'aal2';
  /** When the session last passed the second factor. */
  aal2At?: Date;
}

export interface SessionValue extends SessionSignIn {
  /** The selected tenant; undefined means nobody is signed in. */
  tenant: SessionTenant | undefined;
  tenants: readonly SessionTenant[];
  user: SessionUser | undefined;
  /** Modules the user may open; the server still decides every request. */
  access: NavigationAccess;
  switchTenant(tenantId: string): void;
  /** The bearer token for the API client, undefined when there is no session. */
  getSession(): Promise<{ token: string } | undefined>;
  /** Permissions the membership holds as the screens know them (read-only modes); undefined means unknown. The server still decides. */
  permissions?: readonly string[];
  assurance?: SessionAssurance;
  /** Asks the user for the second factor; resolves once the session is `aal2`. */
  requestStepUp?(): Promise<void>;
}

/** One membership the chooser offers: the tenant it belongs to and the state of both (listTenantSelectionCandidates). */
export type TenantCandidate = components['schemas']['TenantSelectionCandidate'];

/** FULL, or READ_ONLY while the selected tenant is suspended: the session may read and export, never change anything. */
export type SessionMode = 'FULL' | 'READ_ONLY';

/** Where the sign-in of an OIDC session stands; development sessions leave it undefined. */
export type SessionStatus = 'signedOut' | 'identified' | 'active';

/** The identity the provider authenticated, before and after a tenant is chosen. */
export interface SessionIdentity {
  subject: string;
  displayName: string;
}

/** The tenant access token, as far as screens may know it: its lifetime, never its value (the client reads that). */
export interface SessionTenantToken {
  expiresAt: number;
}

/** What only a real sign-in (OIDC) provides; every member is optional so development sessions stay valid. */
export interface SessionSignIn {
  status?: SessionStatus;
  identity?: SessionIdentity;
  tenantToken?: SessionTenantToken;
  /** READ_ONLY makes every screen drop its controls that change data. */
  mode?: SessionMode;
  /** Sends the browser to the identity provider; resolves only if it could not leave. */
  signIn?(options?: { returnTo?: string; acrValues?: string; loginHint?: string }): Promise<void>;
  /** Forgets the identity and the tenant token. */
  signOut?(): void;
  /** Finishes the sign-in after the provider redirected back; resolves with the address to continue at. */
  completeSignIn?(search: string): Promise<{ returnTo: string }>;
  /** The memberships the signed-in person may choose from. */
  loadCandidates?(): Promise<readonly TenantCandidate[]>;
  /** Chooses a membership: one intention keeps one idempotency key until the server gives a final answer. */
  selectTenant?(candidate: TenantCandidate): Promise<void>;
  /** Accepts an invitation with its one-time token under the identity of the signed-in person (no tenant is chosen yet); one intention keeps one idempotency key until the server gives a final answer. */
  acceptInvitation?(invitationId: string, token: string): Promise<void>;
}

/** The session of a visitor who has not signed in; it is what production builds provide until OIDC sign-in lands. */
export const SIGNED_OUT: SessionValue = {
  tenant: undefined,
  tenants: [],
  user: undefined,
  access: ALL_MODULES_VISIBLE,
  switchTenant: () => undefined,
  getSession: () => Promise.resolve(undefined),
};

export const SessionContext = createContext<SessionValue>(SIGNED_OUT);

export function useSession(): SessionValue {
  return useContext(SessionContext);
}
