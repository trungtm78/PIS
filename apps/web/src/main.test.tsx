import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import viCatalogue from './i18n/vi.json';

// Importing main after resetModules loads the whole application cold (every module, under coverage), which can take
// several seconds on a busy machine: this test and the missing-root one wait for that import explicitly.
const COLD_IMPORT_TIMEOUT_MS = 30_000;

describe('main', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
  });

  it('mounts the application into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    expect(await screen.findByRole('navigation', { name: viCatalogue['shell.nav.main.label'] }, { timeout: COLD_IMPORT_TIMEOUT_MS })).toBeInTheDocument();
  }, COLD_IMPORT_TIMEOUT_MS);

  it('mounts the enterprise edition under its own name when VITE_EDITION says so', async () => {
    vi.stubEnv('VITE_EDITION', 'enterprise');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    expect(await screen.findByRole('navigation', { name: viCatalogue['shell.nav.main.label'] }, { timeout: COLD_IMPORT_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Phần mềm quản lý đầu tư xây dựng')).toBeInTheDocument();
    const { resetEdition } = await import('./editions/edition');
    resetEdition();
  }, COLD_IMPORT_TIMEOUT_MS);

  it('shows the error card, never an empty page, when the bundle of the edition does not load', async () => {
    vi.stubEnv('VITE_EDITION', 'enterprise');
    vi.doMock('./editions/load', () => ({ loadWebEdition: () => Promise.reject(new Error('chunk lost')) }));
    document.body.innerHTML = '<div id="root"><p data-boot>placeholder</p></div>';
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await import('./main');
      expect(await screen.findByText(viCatalogue['states.crash.title'], undefined, { timeout: COLD_IMPORT_TIMEOUT_MS })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: viCatalogue['states.crash.home'] })).toBeInTheDocument();
      expect(document.querySelector('[data-boot]')).toBeNull();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.doUnmock('./editions/load');
    }
  }, COLD_IMPORT_TIMEOUT_MS);

  it('stops the start for a VITE_EDITION that is not an edition', async () => {
    vi.stubEnv('VITE_EDITION', 'enterprise-plus');
    document.body.innerHTML = '<div id="root"></div>';
    await expect(import('./main')).rejects.toThrow('VITE_EDITION');
  }, COLD_IMPORT_TIMEOUT_MS);

  it('fails with a clear error when #root is missing', async () => {
    await expect(import('./main')).rejects.toThrow('#root');
  }, COLD_IMPORT_TIMEOUT_MS);
});
