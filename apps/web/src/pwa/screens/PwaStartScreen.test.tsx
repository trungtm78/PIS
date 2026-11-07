import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { pwaStore } from '../pwa-state';
import { DEVICE_STORAGE_KEY } from '../push-client';
import type { PushControlDeps } from '../usePushControl';
import PwaStartScreen from './PwaStartScreen';
import { FAR_PAST, approvalTask, mountPwa, pwaClient, word } from './test-support';

const SUBSCRIPTION = { endpoint: 'https://push.example/send/abc', keys: { p256dh: 'BPk', auth: 'a' } };

function storage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return Object.assign({ data }, { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) }) as unknown as Storage & { data: Map<string, string> };
}

function pushDeps(overrides: Partial<PushControlDeps> & { subscribed?: boolean } = {}) {
  let subscribed = overrides.subscribed ?? false;
  const subscription = { toJSON: () => SUBSCRIPTION, unsubscribe: vi.fn(() => ((subscribed = false), Promise.resolve(true))) };
  const subscribe = vi.fn(() => ((subscribed = true), Promise.resolve(subscription)));
  const registration = { pushManager: { getSubscription: () => Promise.resolve(subscribed ? subscription : null), subscribe } } as unknown as ServiceWorkerRegistration;
  const deps: PushControlDeps = {
    support: 'supported',
    vapidPublicKey: 'AQID',
    registration: () => Promise.resolve(registration),
    permission: () => 'default',
    requestPermission: () => Promise.resolve('granted'),
    storage: storage(),
    ...overrides,
  };
  return { deps, subscribe, subscription };
}

function open(options: { permissions?: readonly string[] | undefined; deps?: PushControlDeps; manualInstall?: boolean; tasks?: Array<Record<string, unknown>> } = {}) {
  const h = pwaClient({
    readAll: (operation) => (operation === 'get_resources_approval_task' ? (options.tasks ?? []) : new Error(`unexpected ${operation}`)),
  });
  const deps = options.deps ?? pushDeps().deps;
  const mounted = mountPwa(<PwaStartScreen pushDeps={deps} {...(options.manualInstall === undefined ? {} : { manualInstall: options.manualInstall })} />, h, { permissions: 'permissions' in options ? options.permissions : ['approval_task.read'], path: '/m' });
  return { ...h, ...mounted, deps };
}

const secureContext = (value: boolean): void => {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
};

beforeEach(() => {
  pwaStore.reset();
  // jsdom is not a secure context; a page served over HTTPS (or from localhost) is.
  secureContext(true);
});
afterEach(() => {
  cleanup();
  pwaStore.reset();
  Reflect.deleteProperty(window, 'isSecureContext');
});

describe('PwaStartScreen (PWA-01): the page the installed application opens', () => {
  it('opens each of the three manager screens from its own entry, with a target of at least 44 px', () => {
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('pwa.start.page.title'));
    const entries = within(screen.getByRole('navigation', { name: word('pwa.start.entries.aria') })).getAllByRole('link');
    expect(entries.map((entry) => entry.getAttribute('href'))).toEqual(['/m/approvals', '/m/dashboard', '/m/directives']);
    for (const entry of entries) expect(entry.className).toContain('pwa-touch');
    expect(entries[0]?.textContent).toContain(word('pwa.start.approvals.title'));
  });

  it('tells how many approvals wait and how many are late, and reads nothing without the right to read them', async () => {
    const h = open({ tasks: [approvalTask(1), approvalTask(2, { overdue: true, due_at: FAR_PAST })] });
    expect((await screen.findByTestId('approvals-count')).textContent).toBe('2 việc chờ duyệt, 1 quá hạn');
    h.unmount();
    const none = open({ tasks: [approvalTask(1)], permissions: ['home.read'] });
    expect(screen.queryByTestId('approvals-count')).toBeNull();
    expect(none.readAll).not.toHaveBeenCalled();
  });

  it('shows no count while it is not known, never a 0', () => {
    const h = pwaClient({ readAll: () => new Promise(() => undefined) });
    mountPwa(<PwaStartScreen pushDeps={pushDeps().deps} />, h, { permissions: ['approval_task.read'] });
    expect(screen.queryByTestId('approvals-count')).toBeNull();
  });

  describe('installing', () => {
    it('says the application is installed', () => {
      pwaStore.setInstalled(true);
      open();
      expect(screen.getByTestId('install-state').getAttribute('data-state')).toBe('installed');
    });

    it('offers the install button when the browser offers the install, and asks the browser when pressed', async () => {
      const prompt = vi.fn(() => Promise.resolve('accepted' as const));
      pwaStore.installAvailable(prompt);
      open();
      expect(screen.getByTestId('install-state').getAttribute('data-state')).toBe('available');
      fireEvent.click(screen.getByRole('button', { name: word('pwa.install.action.install') }));
      expect(prompt).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole('button', { name: word('pwa.install.action.install') })).toBeNull());
    });

    it('tells an iPhone user the steps of Safari, and others where the browser menu is', () => {
      const ios = open({ manualInstall: true });
      expect(screen.getByTestId('install-state').getAttribute('data-state')).toBe('manual');
      expect(within(screen.getByTestId('install-card')).getAllByRole('listitem')).toHaveLength(3);
      ios.unmount();
      open({ manualInstall: false });
      expect(screen.getByTestId('install-state').getAttribute('data-state')).toBe('menu');
    });

    it('says an insecure page cannot be installed', () => {
      secureContext(false);
      open();
      expect(screen.getByTestId('install-state').getAttribute('data-state')).toBe('insecure');
      expect(screen.getByRole('alert').textContent).toContain('HTTPS');
    });
  });

  describe('push notifications', () => {
    it('promises that a notification carries no amount and no name', () => {
      open();
      expect(screen.getByTestId('push-card').textContent).toContain('Không hiện số tiền hay tên người');
    });

    it('turns them on from a tap: asks the permission, subscribes and registers the device', async () => {
      const world = pushDeps();
      const h = open({ deps: world.deps });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
      fireEvent.click(screen.getByRole('button', { name: word('pwa.push.action.enable') }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
      expect(world.subscribe).toHaveBeenCalledTimes(1);
      const call = h.command.mock.calls.find((c) => c[0] === 'registerDevice');
      expect((call?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ platform: 'web', permission_state: 'granted' });
      expect(world.deps.storage?.getItem(DEVICE_STORAGE_KEY)).toContain('web-');
    });

    it('turns them off: the device is removed at the server and the subscription ended', async () => {
      const world = pushDeps({ subscribed: true });
      world.deps.storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ publicId: 'web-abc', registrationId: '00000000-0000-4000-8000-000000000001' }));
      const h = open({ deps: world.deps });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
      fireEvent.click(screen.getByRole('button', { name: word('pwa.push.action.disable') }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
      expect(h.command.mock.calls.some((c) => c[0] === 'revokeMyDevice')).toBe(true);
      expect(world.subscription.unsubscribe).toHaveBeenCalled();
      expect(world.deps.storage?.getItem(DEVICE_STORAGE_KEY)).toBeNull();
    });

    it('says why it cannot: a permission that is blocked, a browser without push, a deployment without a key', async () => {
      const blocked = open({ deps: pushDeps({ permission: () => 'denied' }).deps });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('blocked'));
      expect(screen.queryByRole('button', { name: word('pwa.push.action.enable') })).toBeNull();
      blocked.unmount();
      const unsupported = open({ deps: pushDeps({ support: 'unsupported' }).deps });
      expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('unsupported');
      unsupported.unmount();
      open({ deps: pushDeps({ support: 'unconfigured' }).deps });
      expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('unconfigured');
    });

    it('goes to blocked when the person refuses the permission, and to failed with a retry when the registration fails', async () => {
      const refused = open({ deps: pushDeps({ requestPermission: () => Promise.resolve('denied') }).deps });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
      fireEvent.click(screen.getByRole('button', { name: word('pwa.push.action.enable') }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('blocked'));
      refused.unmount();

      const world = pushDeps();
      const h = pwaClient({ readAll: () => [], command: () => new Error('server') });
      mountPwa(<PwaStartScreen pushDeps={world.deps} />, h, { permissions: ['approval_task.read'] });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
      fireEvent.click(screen.getByRole('button', { name: word('pwa.push.action.enable') }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('failed'));
      // The person can try again.
      expect(screen.getByRole('button', { name: word('pwa.push.action.enable') })).toBeInTheDocument();
    });

    it('says it cannot when there is no worker registered (a development build)', async () => {
      open({ deps: pushDeps({ registration: () => Promise.resolve(undefined) }).deps });
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
      fireEvent.click(screen.getByRole('button', { name: word('pwa.push.action.enable') }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('failed'));
    });
  });

  it('has no serious accessibility violation', async () => {
    open({ tasks: [approvalTask(1)] });
    await screen.findByTestId('approvals-count');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
