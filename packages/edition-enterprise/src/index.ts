import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { defineAdapterRegistry } from './adapters.ts';
import type { AdapterRegistry } from './adapters.ts';
import { ENTERPRISE_EDITION_MANIFEST } from './manifest.ts';

export { ADAPTER_KINDS, defineAdapterRegistry } from './adapters.ts';
export type { AdapterKind, AdapterRegistry, EditionAdapter } from './adapters.ts';
export { ENTERPRISE_EDITION_MANIFEST } from './manifest.ts';

/** The adapters of the enterprise edition: none yet; the HPM and EBS lanes add theirs here. */
export const ENTERPRISE_ADAPTERS: AdapterRegistry = defineAdapterRegistry([]);

/** What the composition root of a process loads for the enterprise edition. */
export interface EnterpriseEdition {
  readonly manifest: EditionManifest;
  readonly adapters: AdapterRegistry;
}

export const ENTERPRISE_EDITION: EnterpriseEdition = { manifest: ENTERPRISE_EDITION_MANIFEST, adapters: ENTERPRISE_ADAPTERS };
