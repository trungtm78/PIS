import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../SessionContext';

export interface SignInAttempt {
  /** Starts the sign-in; a failure (provider unreachable, discovery refused) is kept instead of thrown. */
  start(options?: { returnTo?: string; acrValues?: string; loginHint?: string }): void;
  /** The last start failed before the browser left for the provider. */
  failed: boolean;
}

/** One place that turns a failed sign-in start into a state the screen can show, instead of an unhandled rejection. */
export function useSignInAttempt(): SignInAttempt {
  const { signIn } = useSession();
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = useCallback(
    (options?: { returnTo?: string; acrValues?: string; loginHint?: string }) => {
      setFailed(false);
      Promise.resolve()
        .then(() => signIn?.(options))
        .catch(() => {
          if (mounted.current) setFailed(true);
        });
    },
    [signIn],
  );
  return { start, failed };
}
