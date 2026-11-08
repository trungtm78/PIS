import { PUBLIC_EDITION_MANIFEST, moduleInMenu, screenInEdition } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { translator } from '../i18n';
import type { Catalogue, Locale } from '../i18n';
import type { NavigationAccess } from '../navigation/model';
import type { ScreenLoader, WebRoute } from '../routes/types';

/**
 * What the web build of one edition is made of (ENT-0): the manifest (names, module, screen and menu lists, rule packs) and the terminology
 * overlay, the words of the base catalogue the edition says its own way. The public edition has no overlay. The enterprise bundle is built
 * in `editions/enterprise` and reaches the application only through `editions/load.ts`.
 */
export interface WebEditionBundle {
  readonly manifest: EditionManifest;
  readonly overlay?: Readonly<Record<Locale, Catalogue>>;
  /**
   * The screens the edition brings with it, by screen id (ENT-2): code that lives in the edition's own folder and reaches the application through this bundle only, so the table of screens of the
   * public product names none of it. `resolveScreen` reads them after the screens of the table.
   */
  readonly screens?: Readonly<Record<string, ScreenLoader>>;
}

export const PUBLIC_BUNDLE: WebEditionBundle = { manifest: PUBLIC_EDITION_MANIFEST };

let active: WebEditionBundle = PUBLIC_BUNDLE;
const listeners = new Set<() => void>();

/** The edition the application runs as. Public until `installEdition` is called, which `main.tsx` does once before the first render. */
export function getEdition(): WebEditionBundle {
  return active;
}

export function subscribeEdition(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Makes the bundle the edition of the application: its terminology overlay goes to the translator, and what listens is told. Call it before the first render. */
export function installEdition(bundle: WebEditionBundle): void {
  active = bundle;
  translator.setOverlay(bundle.overlay);
  listeners.forEach((listener) => listener());
}

/** Back to the public edition (tests). */
export function resetEdition(): void {
  installEdition(PUBLIC_BUNDLE);
}

/** Whether the screen exists in the edition: its module and the screen itself are listed. */
export function routeInEdition(route: Pick<WebRoute, 'id' | 'module'>, manifest: EditionManifest = active.manifest): boolean {
  return screenInEdition(manifest, route);
}

/** The routes of the table that exist in the edition, in their own order; the same array for the public edition. */
export function editionRoutes(routes: readonly WebRoute[], manifest: EditionManifest = active.manifest): readonly WebRoute[] {
  return manifest === PUBLIC_EDITION_MANIFEST ? routes : routes.filter((route) => routeInEdition(route, manifest));
}

/** The access of the session narrowed by the menu of the edition: a module is visible when the session may open it and the edition offers it. */
export function editionAccess(access: NavigationAccess, manifest: EditionManifest = active.manifest): NavigationAccess {
  if (manifest === PUBLIC_EDITION_MANIFEST) return access;
  return { isModuleVisible: (module) => moduleInMenu(manifest, module) && access.isModuleVisible(module) };
}
