import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '../session/SessionContext';
import { SignInGate } from '../session/oidc/SignInGate';
import { StateBoundary } from '../states/StateBoundary';

/**
 * What stands in front of a screen of the manager application until a person is signed in and has chosen a tenant, the same three answers as every screen
 * of the route table: the way in for nobody, the tenant chooser for a person who is known and has not chosen, the lapsed-session card otherwise.
 */
export function SessionGate({ next, chooserPath, children }: { next: string; chooserPath: string; children: ReactNode }) {
  const session = useSession();
  if (session.status === 'signedOut' && session.signIn !== undefined) return <SignInGate />;
  if (session.tenant === undefined) {
    if (session.status === 'identified') return <Navigate to={`${chooserPath}?next=${encodeURIComponent(next)}`} replace />;
    return <StateBoundary state="signedOut" />;
  }
  return <>{children}</>;
}
