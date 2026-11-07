import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useApiClient } from '../api/ApiClientContext';
import { SessionContext, useSession } from '../session/SessionContext';
import { purgeClientState } from './purge';
import type { PurgeDeps } from './purge';
import { readStoredDevice, revokeDevice } from './push-client';
import { UpdateBanner } from './UpdateBanner';

/** How long a sign-out waits for the server to remove the device before it goes on without it. */
export const REVOKE_WAIT_MS = 3000;

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the installed application from leaving a person's data on a shared phone (R7). When the session ends, whether the person signed out or it expired,
 * everything the application keeps on the device is dropped (`purgeClientState`: the caches, the worker's caches, the push subscription, the device
 * record, the memory of the page). A sign-out through the session first asks the server to remove the device record and its subscription, while the
 * session can still ask (the server revokes the device with the session in any case), waiting at most `REVOKE_WAIT_MS`.
 * It also shows the "new version" banner, on every screen.
 */
export function PwaSessionGuard({ children, purgeDeps }: { children: ReactNode; purgeDeps?: Partial<PurgeDeps> }) {
  const session = useSession();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const signedIn = session.tenant !== undefined;
  const was = useRef(signedIn);

  useEffect(() => {
    if (was.current && !signedIn) {
      void purgeClientState({
        cacheStorage: typeof caches === 'undefined' ? undefined : caches,
        container: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
        storage: browserStorage(),
        clearMemory: () => queryClient.clear(),
        ...purgeDeps,
      });
    }
    was.current = signedIn;
  }, [signedIn, queryClient, purgeDeps]);

  const signOutOfSession = session.signOut;
  const signOut = useCallback(() => {
    const storage = browserStorage();
    const mustAskServer = readStoredDevice(storage)?.registrationId !== undefined;
    const finish = (): void => signOutOfSession?.();
    if (!mustAskServer) {
      finish();
      return;
    }
    void Promise.race([revokeDevice(client, storage, 'The person signed out of the installed application.'), new Promise((resolve) => setTimeout(resolve, REVOKE_WAIT_MS))]).finally(finish);
  }, [client, signOutOfSession]);

  const value = useMemo(() => (signOutOfSession === undefined ? session : { ...session, signOut }), [session, signOutOfSession, signOut]);
  return (
    <SessionContext.Provider value={value}>
      {children}
      <UpdateBanner />
    </SessionContext.Provider>
  );
}
