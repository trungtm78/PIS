import { EditionError } from '@machvon/kernel/src/edition.ts';
import type { Edition } from '@machvon/kernel/src/edition.ts';
import { PUBLIC_BUNDLE } from './edition';
import type { WebEditionBundle } from './edition';

/** Loads the enterprise bundle; tests give their own. */
export type EnterpriseBundleLoader = () => Promise<{ enterpriseBundle: WebEditionBundle }>;

/**
 * The one place of the web application that names the enterprise folder (ENT-0, structure B). The condition is a build-time constant
 * (`VITE_EDITION` is replaced by its value), so a build of the public edition drops the import and the enterprise code never reaches its
 * bundle; `npm run edition:check` and the module-boundary rules allow this file and no other shared one to name the folder.
 */
const buildLoader: EnterpriseBundleLoader | null = import.meta.env.VITE_EDITION === 'enterprise' ? () => import('./enterprise') : null;

/** The bundle of the edition (`null` as the loader: a build that carries none). The enterprise edition fails, naming the edition, when this build does not carry it. */
export async function loadWebEdition(edition: Edition, loader: EnterpriseBundleLoader | null = buildLoader): Promise<WebEditionBundle> {
  if (edition === 'public') return PUBLIC_BUNDLE;
  if (loader === null) throw new EditionError('the enterprise edition was selected but this build does not carry it (build with VITE_EDITION=enterprise)');
  const { enterpriseBundle } = await loader();
  if (enterpriseBundle.manifest.edition !== 'enterprise') throw new EditionError('the bundle loaded as the enterprise edition is not an enterprise one');
  return enterpriseBundle;
}
