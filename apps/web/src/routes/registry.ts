import { lazy } from 'react';
import { getEdition, routeInEdition } from '../editions/edition';
import { NotImplementedScreen } from './NotImplementedScreen';
import { WEB_ROUTES } from './web-routes.ts';
import { screenModules } from './screens/index';
import type { ScreenComponent, ScreenLoader, WebRoute } from './types.ts';

const BY_ID: ReadonlyMap<string, WebRoute> = new Map(WEB_ROUTES.map((route) => [route.id, route]));
const BY_PATH: ReadonlyMap<string, WebRoute> = new Map(WEB_ROUTES.map((route) => [route.path, route]));

/** The route of an id; a screen the edition does not have is not found (ENT-0), as if it were not in the table. */
export function routeById(id: string): WebRoute | undefined {
  const route = BY_ID.get(id);
  return route !== undefined && routeInEdition(route) ? route : undefined;
}

/** The route of a location path; the match ignores case and a trailing slash. */
export function routeByPath(path: string): WebRoute | undefined {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const route = BY_PATH.get(trimmed.toLowerCase());
  return route !== undefined && routeInEdition(route) ? route : undefined;
}

const loaded = new Map<ScreenLoader, ScreenComponent>();

function lazyScreen(loader: ScreenLoader): ScreenComponent {
  const known = loaded.get(loader);
  if (known !== undefined) return known;
  const component = lazy(loader);
  loaded.set(loader, component);
  return component;
}

/**
 * The component of a screen: the lazily loaded implementation when one is registered for the id (one chunk per
 * screen module), otherwise the shared "not implemented yet" screen, so every route of the table can be opened.
 */
export function resolveScreen(id: string, modules: Readonly<Record<string, ScreenLoader>> = screenModules): ScreenComponent {
  // The screens of the table first, then the ones the edition in force brings with it (the enterprise connections).
  const loader = modules[id] ?? getEdition().screens?.[id];
  return loader === undefined ? NotImplementedScreen : lazyScreen(loader);
}
