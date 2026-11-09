import { installServiceWorker } from './sw-core';
import type { ServiceWorkerScopeLike } from './sw-core';
import { pushWordsFor } from './sw-texts';

/**
 * The entry of the service worker, bundled by `vite.pwa.ts` to `/sw.js` (never imported by the application). The build defines the three constants:
 * the id of the build, the files of the shell and the name the product has in this edition. The logic is in `sw-core.ts` and `cache-policy.ts`.
 */
declare const __MV_BUILD_ID__: string;
declare const __MV_PRECACHE__: readonly string[];
declare const __MV_APP_NAME__: string;
declare const __MV_API_BASE__: string;

const scope = self as unknown as ServiceWorkerScopeLike & { navigator?: { language?: string } };
installServiceWorker(scope, {
  buildId: __MV_BUILD_ID__,
  precache: __MV_PRECACHE__,
  words: pushWordsFor(scope.navigator?.language, __MV_APP_NAME__),
  icon: '/icons/icon-192.png',
  apiBase: __MV_API_BASE__,
});
