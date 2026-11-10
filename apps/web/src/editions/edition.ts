import type { ComponentType } from 'react';
import { PUBLIC_EDITION_MANIFEST, moduleInMenu, screenInEdition } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { translator } from '../i18n';
import type { Catalogue, Locale } from '../i18n';
import type { NavigationAccess } from '../navigation/model';
import type { ScreenComponent, ScreenLoader, WebRoute } from '../routes/types';

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
  /**
   * Places inside screens of the shared table where the edition adds a part of its own (ENT-4d): the leader panel of the enterprise edition (rates against the annual plan by company, unit and project, and the tiles of what
   * is blocked or overdue) shows on the command center and the committee dashboard through this slot; a public build has none and the screens draw nothing in its place.
   */
  readonly slots?: WebEditionSlots;
}

/** Which part of the leader panel a screen asks for: the rates, the tiles, or both one under the other. */
export type LeaderPanelPart = 'rates' | 'tiles' | 'all';

export interface WebEditionSlots {
  readonly leaderPanel?: ComponentType<{ part: LeaderPanelPart }>;
  /** The funding structure screen (HOME-07) of an edition that counts its capital in classes of its own (the enterprise: equity, loan, other); the public screen of the sources is drawn when there is none. */
  readonly fundingStructure?: ScreenComponent;
  /** How the figures of the command center (HOME-09, HOME-01) are drawn: digits grouped by thousands, and whether the blocks of the public plan (the ratio over the plan the Prime Minister gave) are drawn. */
  readonly homeFigures?: HomeFiguresStyle;
}

export interface HomeFiguresStyle {
  readonly groupDigits: boolean;
  readonly publicPlanBlocks: boolean;
  /**
   * The one source of the amount disbursed that the command block (HOME-09, HOME-01 and the presentation) shows, for an edition that does not report through the Treasury: the enterprise reads its frozen period
   * snapshot through the one reader (rule R21), the very figures of the leader panel and of HOME-07. It is a hook (called on every render, so the number of hooks never changes); the public edition has none and
   * the command block shows the Treasury figure of the command center.
   */
  readonly useDisbursed?: () => HomeDisbursed;
}

/** The disbursement of the frozen snapshot of an edition: whole dong, the day the snapshot is as of and its revision; `none` when nothing is frozen yet (never a 0). */
export type HomeDisbursed = { readonly state: 'loading' } | { readonly state: 'none' } | { readonly state: 'ready'; readonly valueVnd: string; readonly asOfDate: string; readonly revision: number };

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
  // The same array when the edition drops nothing; the public edition drops the routes of the modules that exist in the enterprise edition only.
  const kept = routes.filter((route) => routeInEdition(route, manifest));
  return kept.length === routes.length ? routes : kept;
}

/** The access of the session narrowed by the menu of the edition: a module is visible when the session may open it and the edition offers it. */
export function editionAccess(access: NavigationAccess, manifest: EditionManifest = active.manifest): NavigationAccess {
  return { isModuleVisible: (module) => moduleInMenu(manifest, module) && access.isModuleVisible(module) };
}
