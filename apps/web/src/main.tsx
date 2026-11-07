import { resolveEdition } from '@machvon/kernel/src/edition.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { listenForInstall } from './pwa/install';
import { startServiceWorker } from './pwa/register';
import { installEdition } from './editions/edition';
import { loadWebEdition } from './editions/load';
import './styles/prototype.css';
import './styles/app.css';
import './styles/tenant-theme.css';

// The installed application: the worker is registered in a production build only, and the install prompt is kept for the start page.
listenForInstall();
startServiceWorker();

const container = document.getElementById('root');
if (container === null) throw new Error('Root element #root not found in index.html');

function mount(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The edition is read once, when the page starts (VITE_EDITION; public when it is not set; any other value than an edition stops the start).
// The public edition mounts at once, as it always did; the enterprise edition loads its bundle first and installs it before the first render.
const edition = resolveEdition({ VITE_EDITION: import.meta.env.VITE_EDITION }, 'VITE_EDITION');
if (edition === 'public') {
  mount(container);
} else {
  const root = container;
  loadWebEdition(edition).then(
    (bundle) => {
      installEdition(bundle);
      mount(root);
    },
    (error: unknown) => {
      root.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    },
  );
}
