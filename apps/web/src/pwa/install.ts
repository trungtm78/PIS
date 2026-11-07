import { pwaStore } from './pwa-state';

/** The event a Chromium browser fires when the application can be installed; it is not in the DOM typings. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The page runs as an installed application: the standalone display mode, or the flag iOS Safari sets on a page added to the home screen. */
export function isStandalone(win: Partial<Pick<Window, 'matchMedia'>> & { navigator: Navigator & { standalone?: boolean } }): boolean {
  // A DOM without `matchMedia` (a test, an old browser) is not an installed application.
  return (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) || win.navigator.standalone === true;
}

/** iOS and iPadOS Safari never fire `beforeinstallprompt`: the person installs through the share sheet, so the page tells them how. */
export function needsManualInstall(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

/** Keeps the install prompt of the browser for the button of the start page, and notices an install. */
export function listenForInstall(win: Window = window): () => void {
  pwaStore.setInstalled(isStandalone(win as Window & { navigator: Navigator & { standalone?: boolean } }));
  const onPrompt = (event: Event): void => {
    // The browser's own mini-bar is held back: the button of the start page asks when the person is ready.
    event.preventDefault();
    const prompt = event as BeforeInstallPromptEvent;
    pwaStore.installAvailable(async () => {
      await prompt.prompt();
      return (await prompt.userChoice).outcome;
    });
  };
  const onInstalled = (): void => pwaStore.setInstalled(true);
  win.addEventListener('beforeinstallprompt', onPrompt);
  win.addEventListener('appinstalled', onInstalled);
  return () => {
    win.removeEventListener('beforeinstallprompt', onPrompt);
    win.removeEventListener('appinstalled', onInstalled);
  };
}
