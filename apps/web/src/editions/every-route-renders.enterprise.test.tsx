import { PUBLIC_EDITION_MANIFEST } from '@machvon/kernel/src/edition.ts';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenModules } from '../routes/screens/index';
import { WEB_ROUTES } from '../routes/web-routes';
import { mockMatchMedia, renderApp } from '../test/render';
import { editionRoutes, installEdition, resetEdition } from './edition';
import { enterpriseBundle } from './enterprise';

// Names the enterprise folder, so it carries `.enterprise.` in its name (see screens.enterprise.test.ts).
// A blank page is never acceptable (ENT-MONKEY-01): every route of the table, in both editions, must settle on something a person can read, even when the server answers with a failure.
// The walk renders the real screens (not the stand-in) against a server that always fails, so each one ends in its error state; nothing may render empty, throw, or update a component while another renders.
const SERVER_FAILURE = () => Promise.resolve(new Response(JSON.stringify({ code: 'INTERNAL' }), { status: 500, headers: { 'content-type': 'application/problem+json' } }));
const SETTLE_MS = 15_000;

async function renders(path: string): Promise<void> {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' ').slice(0, 300));
  });
  try {
    renderApp(path, { screens: screenModules });
    const content = document.querySelector('.content, .portal-frame__body') ?? document.body;
    await waitFor(() => expect(content.querySelector('[aria-busy="true"]')).toBeNull(), { timeout: SETTLE_MS });
    expect((content.textContent ?? '').trim()).not.toBe('');
    expect(errors.filter((message) => message.includes('Cannot update a component'))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
}

describe('every route of the table renders content, in each edition', () => {
  beforeEach(() => {
    mockMatchMedia(() => false);
    vi.stubGlobal('fetch', SERVER_FAILURE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEdition();
  });

  const enterpriseRoutes = editionRoutes(WEB_ROUTES, enterpriseBundle.manifest);
  const covered = new Set(enterpriseRoutes.map((route) => route.id));
  const onlyPublic = editionRoutes(WEB_ROUTES, PUBLIC_EDITION_MANIFEST).filter((route) => !covered.has(route.id));

  it.each(enterpriseRoutes.map((route) => [route.id, route.path] as const))('enterprise %s %s', async (_id, path) => {
    installEdition(enterpriseBundle);
    await renders(path);
  });

  // The routes the enterprise manifest drops, still opened in the public edition, so that the whole table is walked.
  it.each(onlyPublic.map((route) => [route.id, route.path] as const))('public %s %s', async (_id, path) => {
    await renders(path);
  });

  it('answers an address that is not in the table with the not-found card and the way back', async () => {
    installEdition(enterpriseBundle);
    await renders('/no/such-screen');
    expect(document.querySelector('[data-state="not-found"] a')).not.toBeNull();
  });
});
