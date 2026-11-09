import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../i18n/vi.json';
import type { ScreenLoader } from '../routes/types';
import { mockMatchMedia, renderApp } from '../test/render';
import { ScreenErrorBoundary } from './ScreenErrorBoundary';

function Broken(): never {
  throw new Error('screen exploded');
}

describe('ScreenErrorBoundary', () => {
  beforeEach(() => {
    mockMatchMedia(() => false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the children while nothing fails', () => {
    render(
      <ScreenErrorBoundary>
        <p>fine</p>
      </ScreenErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error card in Vietnamese, with the reload and the way home, instead of an empty page', () => {
    render(
      <ScreenErrorBoundary>
        <Broken />
      </ScreenErrorBoundary>,
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent(vi_['states.crash.title']);
    expect(card).toHaveTextContent(vi_['states.crash.body']);
    expect(screen.getByRole('button', { name: vi_['states.crash.reload'] })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: vi_['states.crash.home'] })).toHaveAttribute('href', '/');
  });

  it('reloads the page from the card', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(
        <ScreenErrorBoundary>
          <Broken />
        </ScreenErrorBoundary>,
      );
      await userEvent.click(screen.getByRole('button', { name: vi_['states.crash.reload'] }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('tells the host about the error', () => {
    const onError = vi.fn();
    render(
      <ScreenErrorBoundary onError={onError}>
        <Broken />
      </ScreenErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'screen exploded' });
  });

  it('clears the error when the key changes, so the next screen is shown', () => {
    const { rerender } = render(
      <ScreenErrorBoundary resetKey="/a">
        <Broken />
      </ScreenErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(
      <ScreenErrorBoundary resetKey="/b">
        <p>next screen</p>
      </ScreenErrorBoundary>,
    );
    expect(screen.getByText('next screen')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses a router link for the way home inside the router', () => {
    render(
      <MemoryRouter>
        <ScreenErrorBoundary>
          <Broken />
        </ScreenErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: vi_['states.crash.home'] })).toHaveAttribute('href', '/');
  });
});

describe('a screen that breaks inside the shell', () => {
  beforeEach(() => {
    mockMatchMedia(() => false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the error card in the content area and keeps the shell around it', async () => {
    const screens: Record<string, ScreenLoader> = { 'ADM-01': () => Promise.resolve({ default: Broken }) };
    renderApp('/adm/adm-01', { screens });
    expect(await screen.findByText(vi_['states.crash.title'])).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: vi_['shell.nav.main.label'] })).toBeInTheDocument();
  });

  it('shows the error card for a screen chunk that fails to load', async () => {
    const screens: Record<string, ScreenLoader> = { 'ADM-01': () => Promise.reject(new Error('Failed to fetch dynamically imported module')) };
    renderApp('/adm/adm-01', { screens });
    expect(await screen.findByText(vi_['states.crash.title'])).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: vi_['shell.nav.main.label'] })).toBeInTheDocument();
  });
});
