import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from './test/render';
import { App } from './App';
import en from './i18n/en.json';
import { translator } from './i18n/index';
import viCatalogue from './i18n/vi.json';

describe('App', () => {
  afterEach(() => {
    act(() => translator.setLocale('vi'));
    window.history.pushState({}, '', '/');
  });

  it('redirects the root address to the home screen inside the shell, signed in as the development user', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tổng quan điều hành' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/home/home-01');
    expect(screen.getByRole('navigation', { name: viCatalogue['shell.nav.main.label'] })).toBeInTheDocument();
    expect(await screen.findByText('Nguyễn An')).toBeInTheDocument();
  });

  it('sets the tab title from the application name, and follows the locale', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Tổng quan điều hành' });
    expect(document.title).toBe(viCatalogue['shell.app.name.title']);
    act(() => translator.setLocale('en'));
    expect(document.title).toBe(en['shell.app.name.title']);
    expect(screen.getByRole('navigation', { name: en['shell.nav.main.label'] })).toBeInTheDocument();
  });

  it.each([['loading', 'status'], ['empty', 'status'], ['error', 'alert'], ['denied', 'alert'], ['expired', 'alert'], ['offline', 'status']] as const)(
    'forces the %s state on a screen with ?demoState= in a development build, keeping the shell',
    async (state, role) => {
      window.history.pushState({}, '', `/adm/adm-03?demoState=${state}`);
      render(<App />);
      if (state === 'loading') {
        expect(await screen.findByRole('status', { name: viCatalogue['states.loading.label'] })).toBeInTheDocument();
      } else {
        const title = await screen.findByText(viCatalogue[`states.${state}.title`]);
        expect(title.closest(`[role="${role}"]`)).not.toBeNull();
      }
      expect(screen.getByRole('navigation', { name: viCatalogue['shell.nav.main.label'] })).toBeInTheDocument();
      // The frame of the card is the screen's title (the real screen content is not rendered).
      expect(screen.getByRole('heading', { level: 1, name: 'Vai trò và quyền' })).toBeInTheDocument();
      expect(document.querySelector('[data-screen-id]')).toBeNull();
    },
  );

  it('ignores an unknown ?demoState= value and shows the screen', async () => {
    window.history.pushState({}, '', '/adm/adm-03?demoState=sparkles');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Vai trò và quyền' })).toBeInTheDocument();
  });

  it('reads ?demoState= from the router location, not from window.location', async () => {
    renderApp('/adm/adm-03?demoState=denied');
    expect(await screen.findByText(viCatalogue['states.denied.title'])).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Vai trò và quyền' })).toBeInTheDocument();
  });

  it('opens a screen of the route table directly by its address', async () => {
    window.history.pushState({}, '', '/adm/adm-01');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cây tổ chức' })).toBeInTheDocument();
  });
});
