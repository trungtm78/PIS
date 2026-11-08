import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { defineAdapterRegistry } from './adapters.ts';
import type { AdapterRegistry } from './adapters.ts';
import { ENTERPRISE_EDITION_MANIFEST } from './manifest.ts';

export { ADAPTER_KINDS, defineAdapterRegistry } from './adapters.ts';
export type { AdapterKind, AdapterRegistry, EditionAdapter } from './adapters.ts';
export { ENTERPRISE_EDITION_MANIFEST } from './manifest.ts';

/** The adapters of the enterprise edition (ENT-2): the file writer that stands for HPM and the file reader of Oracle EBS, both PENDING-EXTERNAL until the customer gives the interface and a sample file; the other systems add theirs here. */
export const ENTERPRISE_ADAPTERS: AdapterRegistry = defineAdapterRegistry([
  { id: 'hpm.reports', kind: 'hpm' },
  { id: 'ebs.ledger', kind: 'ebs' },
]);

/** What the composition root of a process loads for the enterprise edition. */
export interface EnterpriseEdition {
  readonly manifest: EditionManifest;
  readonly adapters: AdapterRegistry;
}

export const ENTERPRISE_EDITION: EnterpriseEdition = { manifest: ENTERPRISE_EDITION_MANIFEST, adapters: ENTERPRISE_ADAPTERS };
