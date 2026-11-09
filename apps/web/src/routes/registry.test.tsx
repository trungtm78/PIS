import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import vi from '../i18n/vi.json';
import { PUBLIC_EDITION_MANIFEST } from '@machvon/kernel/src/edition.ts';
import { installEdition, resetEdition } from '../editions/edition';
import { NotFound } from './NotFound';
import { resolveScreen, routeById, routeByPath } from './registry';
import { screenModules } from './screens/index';
import { WEB_ROUTES } from './web-routes.ts';
import type { ScreenLoader, ScreenProps } from './types.ts';

// A screen that is not implemented and names its requirement, so that the fallback is what is tested. Every screen of the table is implemented by now, so the route is one the registry does not hold.
function home() {
  const [first] = WEB_ROUTES;
  if (first === undefined) throw new Error('the route table is empty');
  if (screenModules['ZZZ-99'] !== undefined) throw new Error('ZZZ-99 must stay unimplemented');
  return { ...first, id: 'ZZZ-99', title: 'Màn hình chưa có', path: '/zzz/zzz-99', req: 'FR-ZZZ-99' };
}

describe('route lookup', () => {
  it('finds a route by id and by path, ignoring case and a trailing slash', () => {
    expect(routeById('ADM-01')?.path).toBe('/adm/adm-01');
    expect(routeByPath('/adm/adm-01')?.id).toBe('ADM-01');
    expect(routeByPath('/ADM/ADM-01/')?.id).toBe('ADM-01');
    expect(routeByPath('/')).toBeUndefined();
  });

  it('knows nothing for an unknown id or path', () => {
    expect(routeById('NOPE-01')).toBeUndefined();
    expect(routeByPath('/adm/nope')).toBeUndefined();
  });

  it('has a route for every module screen of the table', () => {
    expect(WEB_ROUTES).toHaveLength(594);
  });
});

describe('resolveScreen', () => {
  it('renders the not-implemented screen with title, id and requirement for a screen without an implementation', () => {
    const Screen = resolveScreen(home().id);
    render(<Screen route={home()} />);
    expect(screen.getByRole('heading', { level: 1, name: home().title })).toBeInTheDocument();
    expect(screen.getByText(vi['shell.screen.notImplemented.title'])).toBeInTheDocument();
    expect(screen.getByText(vi['shell.screen.notImplemented.body'])).toBeInTheDocument();
    expect(screen.getByText(home().id)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(home().req ?? ''))).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-screen-id', home().id);
    // The browser harness tells a fallback from a real screen by this marker.
    expect(screen.getByRole('status')).toHaveAttribute('data-not-implemented');
  });

  it('omits the requirement when the route has none', () => {
    const Screen = resolveScreen(home().id);
    render(<Screen route={{ ...home(), req: null }} />);
    expect(screen.queryByText(/FR-/)).not.toBeInTheDocument();
  });

  it('loads a registered implementation lazily and gives the same component for the same loader', async () => {
    const Implemented = ({ route }: ScreenProps) => <h1>{`Implemented ${route.id}`}</h1>;
    const loader: ScreenLoader = () => Promise.resolve({ default: Implemented });
    const modules = { [home().id]: loader };
    const Screen = resolveScreen(home().id, modules);
    expect(resolveScreen(home().id, modules)).toBe(Screen);
    render(
      <Suspense fallback={<p>waiting</p>}>
        <Screen route={home()} />
      </Suspense>,
    );
    expect(await screen.findByRole('heading', { name: `Implemented ${home().id}` })).toBeInTheDocument();
  });

  it('resolves a screen the edition in force brings with it, after the table, and forgets it with the edition', async () => {
    const Brought = ({ route }: ScreenProps) => <h1>{`Brought ${route.id}`}</h1>;
    const loader: ScreenLoader = () => Promise.resolve({ default: Brought });
    installEdition({ manifest: PUBLIC_EDITION_MANIFEST, screens: { [home().id]: loader, 'ADM-01': loader } });
    try {
      const Screen = resolveScreen(home().id);
      render(
        <Suspense fallback={<p>waiting</p>}>
          <Screen route={home()} />
        </Suspense>,
      );
      expect(await screen.findByRole('heading', { name: `Brought ${home().id}` })).toBeInTheDocument();
      // A screen of the table is never taken over by the edition.
      expect(resolveScreen('ADM-01')).not.toBe(Screen);
    } finally {
      resetEdition();
    }
    const Gone = resolveScreen(home().id);
    render(<Gone route={home()} />);
    expect(screen.getAllByRole('status').some((node) => node.hasAttribute('data-not-implemented'))).toBe(true);
  });

  it('keeps the fallback for ids the registry does not hold', () => {
    const modules = { 'ADM-01': (() => Promise.resolve({ default: () => null })) as ScreenLoader };
    expect(resolveScreen(home().id, modules)).not.toBe(resolveScreen('ADM-01', modules));
  });
});

describe('NotFound', () => {
  it('announces that the address is not in the screen catalogue', () => {
    render(<NotFound />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: vi['shell.notFound.title'] })).toBeInTheDocument();
    expect(screen.getByText(vi['shell.notFound.body'])).toBeInTheDocument();
  });
});

describe('catalogues', () => {
  it('hold the shell route keys in both languages', () => {
    for (const key of ['shell.screen.notImplemented.title', 'shell.screen.notImplemented.body', 'shell.notFound.title', 'shell.notFound.body'] as const) {
      expect(vi[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });
});
