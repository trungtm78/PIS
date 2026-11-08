import { resolveManifest } from '@machvon/kernel';
import type { Edition, EditionManifest } from '@machvon/kernel';
import type { ModuleDescriptor } from '../modules/module-descriptor';
import { loadEnterpriseManifest, loadEnterpriseModules } from './load-enterprise';

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

/** Loads the modules the enterprise edition brings with it; tests give their own. */
export type EnterpriseModulesLoader = () => Promise<readonly ModuleDescriptor[]>;

/** The modules an edition brings with it: none for the public edition (it never loads the enterprise package), the enterprise connections for the enterprise edition (ENT-2). */
export async function loadEditionModules(edition: Edition, loadModules: EnterpriseModulesLoader = loadEnterpriseModules): Promise<readonly ModuleDescriptor[]> {
  return edition === 'public' ? [] : loadModules();
}
