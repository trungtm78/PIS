import { describe, expect, it, vi } from 'vitest';
import { SKIP_WAITING_MESSAGE } from './cache-policy';
import { pwaStore } from './pwa-state';
import { registerServiceWorker, serviceWorkerWanted, startServiceWorker } from './register';
import { isStandalone, listenForInstall, needsManualInstall } from './install';

class Target {
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    (this.listeners.get(type) ?? []).forEach((listener) => listener());
  }
}

class FakeWorker extends Target {
  state = 'installing';
  postMessage = vi.fn();
}

function container(options: { controller?: boolean; waiting?: FakeWorker } = {}) {
  const registration = Object.assign(new Target(), { waiting: (options.waiting ?? null) as FakeWorker | null, installing: null as FakeWorker | null, update: vi.fn(() => Promise.resolve()) });
  const sw = Object.assign(new Target(), {
    controller: options.controller === false ? null : {},
    register: vi.fn(() => Promise.resolve(registration)),
  });
  return { sw, registration };
}

describe('registering the service worker', () => {
  it('registers only in a production build, in a secure context, where the browser has workers', () => {
    const sw = {} as ServiceWorkerContainer;
    expect(serviceWorkerWanted({ PROD: true }, true, sw)).toBe(true);
    expect(serviceWorkerWanted({ PROD: false }, true, sw)).toBe(false);
    expect(serviceWorkerWanted({ PROD: true }, false, sw)).toBe(false);
    expect(serviceWorkerWanted({ PROD: true }, true, undefined)).toBe(false);
  });

  it('does not register in the test build (a development build) at all', () => {
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
    startServiceWorker();
    expect(register).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('registers at the root with the script never taken from the HTTP cache', async () => {
    const { sw } = container();
    await registerServiceWorker({ container: sw as unknown as ServiceWorkerContainer, onUpdateReady: vi.fn(), reload: vi.fn(), schedule: vi.fn() });
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });

  it('offers a waiting worker when one is already there, and takes it only when the person applies the update', async () => {
    const waiting = new FakeWorker();
    const { sw } = container({ waiting });
    const reload = vi.fn();
    let apply: (() => void) | undefined;
    await registerServiceWorker({ container: sw as unknown as ServiceWorkerContainer, onUpdateReady: (a) => (apply = a), reload, schedule: vi.fn() });
    expect(apply).toBeDefined();
    // Nothing happens by itself: no message to the worker and no reload.
    expect(waiting.postMessage).not.toHaveBeenCalled();
    sw.emit('controllerchange');
    expect(reload).not.toHaveBeenCalled();
    apply?.();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING_MESSAGE });
    sw.emit('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
    sw.emit('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a worker that finishes installing later, and offers nothing at the first install', async () => {
    const { sw, registration } = container();
    const onUpdateReady = vi.fn();
    await registerServiceWorker({ container: sw as unknown as ServiceWorkerContainer, onUpdateReady, reload: vi.fn(), schedule: vi.fn() });
    const installing = new FakeWorker();
    registration.installing = installing;
    registration.emit('updatefound');
    installing.state = 'installed';
    installing.emit('statechange');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    const first = container({ controller: false });
    const none = vi.fn();
    await registerServiceWorker({ container: first.sw as unknown as ServiceWorkerContainer, onUpdateReady: none, reload: vi.fn(), schedule: vi.fn() });
    const fresh = new FakeWorker();
    first.registration.installing = fresh;
    first.registration.emit('updatefound');
    fresh.state = 'installed';
    fresh.emit('statechange');
    expect(none).not.toHaveBeenCalled();
  });

  it('asks for a newer worker on the schedule it is given', async () => {
    const { sw, registration } = container();
    let check: (() => void) | undefined;
    await registerServiceWorker({ container: sw as unknown as ServiceWorkerContainer, onUpdateReady: vi.fn(), reload: vi.fn(), schedule: (c) => (check = c) });
    check?.();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});

describe('the shared state of the installed application', () => {
  it('keeps the update and the install prompt for the screens', async () => {
    pwaStore.reset();
    expect(pwaStore.get()).toEqual({ updateReady: false, canInstall: false, installed: false });
    const apply = vi.fn();
    pwaStore.updateReady(apply);
    expect(pwaStore.get().updateReady).toBe(true);
    pwaStore.applyUpdate();
    expect(apply).toHaveBeenCalled();
    expect(await pwaStore.promptInstall()).toBe('unavailable');
    const prompt = vi.fn(() => Promise.resolve('accepted' as const));
    pwaStore.installAvailable(prompt);
    expect(pwaStore.get().canInstall).toBe(true);
    expect(await pwaStore.promptInstall()).toBe('accepted');
    expect(pwaStore.get().canInstall).toBe(false);
    pwaStore.setInstalled(true);
    expect(pwaStore.get().installed).toBe(true);
    pwaStore.reset();
  });

  it('keeps the browser prompt for the button and notices an install', async () => {
    pwaStore.reset();
    const stop = listenForInstall(window);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' }> };
    event.prompt = vi.fn(() => Promise.resolve());
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(pwaStore.get().canInstall).toBe(true);
    expect(await pwaStore.promptInstall()).toBe('accepted');
    expect(event.prompt).toHaveBeenCalled();
    window.dispatchEvent(new Event('appinstalled'));
    expect(pwaStore.get().installed).toBe(true);
    stop();
    pwaStore.reset();
  });

  it('knows an installed application by its display mode or by the flag of iOS Safari', () => {
    const nav = { standalone: false } as Navigator & { standalone?: boolean };
    expect(isStandalone({ matchMedia: () => ({ matches: true }) as MediaQueryList, navigator: nav })).toBe(true);
    expect(isStandalone({ matchMedia: () => ({ matches: false }) as MediaQueryList, navigator: nav })).toBe(false);
    expect(isStandalone({ matchMedia: () => ({ matches: false }) as MediaQueryList, navigator: { standalone: true } as Navigator & { standalone?: boolean } })).toBe(true);
    expect(isStandalone({ navigator: nav })).toBe(false);
  });

  it('tells iOS Safari, which has no install prompt, from the browsers that have one', () => {
    expect(needsManualInstall('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1', 5)).toBe(true);
    expect(needsManualInstall('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 5)).toBe(true);
    expect(needsManualInstall('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 0)).toBe(false);
    expect(needsManualInstall('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120 Mobile/15E148 Safari/604.1', 5)).toBe(false);
    expect(needsManualInstall('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 5)).toBe(false);
  });
});
