import { resolveManifest } from '@machvon/kernel';
import type { Edition, EditionManifest } from '@machvon/kernel';
import { loadEnterpriseManifest } from './load-enterprise';

/** Loads the manifest of the enterprise edition; tests give their own. */
export type EnterpriseLoader = () => Promise<EditionManifest>;

/**
 * The manifest of the edition a process serves. The public edition needs nothing but the kernel; the enterprise edition loads its package
 * (and fails at start, naming the edition, when the package cannot be loaded or hands over the wrong manifest).
 */
export async function loadEditionManifest(edition: Edition, loadEnterprise: EnterpriseLoader = loadEnterpriseManifest): Promise<EditionManifest> {
  if (edition === 'public') return resolveManifest('public');
  return resolveManifest('enterprise', await loadEnterprise());
}
