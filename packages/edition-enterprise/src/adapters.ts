/**
 * The adapters of the enterprise edition to the systems around it: HPM (the group's reporting platform), Oracle EBS, the
 * lakehouse and the open API. ENT-0 gives the registry and no adapter; the lanes that build one (INT-1, ENT-2) add it to the list in
 * `index.ts` and nothing else changes. An adapter is a name and a kind here: what it does lives behind the port of its lane.
 */
export const ADAPTER_KINDS = ['hpm', 'ebs', 'lakehouse', 'open-api'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export interface EditionAdapter {
  /** A stable id, lower case with dots (`ebs.ledger`), unique in the registry. */
  readonly id: string;
  readonly kind: AdapterKind;
}

export interface AdapterRegistry {
  readonly all: readonly EditionAdapter[];
  has(id: string): boolean;
  get(id: string): EditionAdapter | undefined;
  ofKind(kind: AdapterKind): readonly EditionAdapter[];
}

const ADAPTER_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

/** Validates the adapters and returns the registry; a malformed or repeated id fails when the package is loaded. */
export function defineAdapterRegistry(adapters: readonly EditionAdapter[]): AdapterRegistry {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    if (!ADAPTER_ID.test(adapter.id)) throw new Error(`adapter id ${adapter.id} must be lower case words joined by dots`);
    if (!ADAPTER_KINDS.includes(adapter.kind)) throw new Error(`adapter ${adapter.id} has an unknown kind`);
    if (ids.has(adapter.id)) throw new Error(`adapter ${adapter.id} is registered twice`);
    ids.add(adapter.id);
  }
  const all = Object.freeze([...adapters]);
  return {
    all,
    has: (id) => ids.has(id),
    get: (id) => all.find((adapter) => adapter.id === id),
    ofKind: (kind) => all.filter((adapter) => adapter.kind === kind),
  };
}
