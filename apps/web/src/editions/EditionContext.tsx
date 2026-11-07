import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { getEdition, subscribeEdition } from './edition';
import type { WebEditionBundle } from './edition';

const EditionContext = createContext<WebEditionBundle | undefined>(undefined);

/** Gives a subtree another edition than the installed one (tests, previews); the application itself needs no provider. */
export function EditionProvider({ edition, children }: { edition: WebEditionBundle; children: ReactNode }) {
  return <EditionContext.Provider value={edition}>{children}</EditionContext.Provider>;
}

/** The edition of the nearest provider, or the one installed for the application. */
export function useEdition(): WebEditionBundle {
  const installed = useSyncExternalStore(subscribeEdition, getEdition);
  return useContext(EditionContext) ?? installed;
}
