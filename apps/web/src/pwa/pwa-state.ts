import { useSyncExternalStore } from 'react';

/** What the page knows about the installed-application side of itself, shared by the screens that show it. */
export interface PwaState {
  /** A new version of the application is waiting; `applyUpdate` makes it take over (and the page reloads). */
  updateReady: boolean;
  /** The browser offers to install (a `beforeinstallprompt` was kept). */
  canInstall: boolean;
  /** The page runs as an installed application (`display-mode: standalone`). */
  installed: boolean;
}

const INITIAL: PwaState = { updateReady: false, canInstall: false, installed: false };

let state: PwaState = INITIAL;
let applyUpdateHandler: (() => void) | undefined;
let installHandler: (() => Promise<'accepted' | 'dismissed'>) | undefined;
const listeners = new Set<() => void>();

function publish(next: Partial<PwaState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export const pwaStore = {
  get: (): PwaState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** A new worker is waiting: the screens offer the update, and `apply` takes it. */
  updateReady(apply: () => void): void {
    applyUpdateHandler = apply;
    publish({ updateReady: true });
  },
  applyUpdate(): void {
    applyUpdateHandler?.();
  },
  installAvailable(prompt: () => Promise<'accepted' | 'dismissed'>): void {
    installHandler = prompt;
    publish({ canInstall: true });
  },
  async promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (installHandler === undefined) return 'unavailable';
    const prompt = installHandler;
    installHandler = undefined;
    publish({ canInstall: false });
    return prompt();
  },
  setInstalled(installed: boolean): void {
    publish({ installed, ...(installed ? { canInstall: false } : {}) });
  },
  /** For tests: forgets everything. */
  reset(): void {
    state = INITIAL;
    applyUpdateHandler = undefined;
    installHandler = undefined;
    listeners.forEach((listener) => listener());
  },
};

export function usePwaState(): PwaState {
  return useSyncExternalStore(pwaStore.subscribe, pwaStore.get, pwaStore.get);
}
