import { PROJECT_CODE_EXTERNAL_TYPE } from '@machvon/kernel';
import { EBS_SOURCE_SYSTEM } from './ebs-rules.ts';

/**
 * The code of a project in the systems the enterprise edition talks to (ENT-3e, MD.01, TH.03, eng-review R25). The code is a row of `master_crosswalk` (INT-1: subject PROJECT, external type `PROJECT_CODE`, the maker-checker life
 * of EGP-1, a validity range) whose `source_system` is `EBS` or `HPM`; nothing about it is stored anywhere else. This module is the pure half: given the rows, it says which project a code of the other system stands for (inbound,
 * the Oracle EBS import) and which code of the other system a project of ours goes under (outbound, the HPM package).
 *
 * Expand then contract (R25): the crosswalk is the way; the direct match (the code of the other system is the code of one of our projects, which is what the import did before the crosswalk existed) stays as the
 * fallback for one version, so every import that was reconciled by direct match is read the same way. The contract step, dropping the fallback, is a later version once the coverage the mapping screen shows has no project that depends on it.
 */

/** The names of the pairs (system, type) in the words of the plan: the external types `EBS_PROJECT_CODE` and `HPM_PROJECT_CODE`. */
/** The code under which Oracle EBS is registered in `int_source_system` is the one its file import already names (`ORACLE_EBS`): one system, one code. */
export const EBS_CODE_SYSTEM = EBS_SOURCE_SYSTEM;
export const HPM_CODE_SYSTEM = 'HPM';
export const ENTERPRISE_CODE_SYSTEMS = [EBS_CODE_SYSTEM, HPM_CODE_SYSTEM] as const;
export type EnterpriseCodeSystem = (typeof ENTERPRISE_CODE_SYSTEMS)[number];
export const EBS_PROJECT_CODE = Object.freeze({ sourceSystem: EBS_CODE_SYSTEM, externalType: PROJECT_CODE_EXTERNAL_TYPE });
export const HPM_PROJECT_CODE = Object.freeze({ sourceSystem: HPM_CODE_SYSTEM, externalType: PROJECT_CODE_EXTERNAL_TYPE });
export const isEnterpriseCodeSystem = (value: unknown): value is EnterpriseCodeSystem => typeof value === 'string' && (ENTERPRISE_CODE_SYSTEMS as readonly string[]).includes(value);

/** How the two systems are registered in `int_source_system` of a tenant (the kind and the format the guard of INT-1 checks a code against). The patterns are working assumptions until the customer gives the real formats (PENDING-EXTERNAL). */
export const ENTERPRISE_SYSTEM_SEEDS: ReadonlyArray<{ code: EnterpriseCodeSystem; kind: 'ERP' | 'PMIS'; codePattern: string }> = Object.freeze([
  { code: EBS_CODE_SYSTEM, kind: 'ERP', codePattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,39}' },
  { code: HPM_CODE_SYSTEM, kind: 'PMIS', codePattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,39}' },
]);

/** Whether the direct match is still a way to read a code. True for this version; the contract step flips it. */
export const DIRECT_MATCH_FALLBACK = true;

export interface CodeMapping {
  projectId: string;
  sourceSystem: string;
  externalCode: string;
  /** First day it holds, `YYYY-MM-DD`. */
  validFrom: string;
  /** First day it no longer holds; null while open. */
  validUntil: string | null;
  status: 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'RETIRED';
}

/** A mapping holds on a day when it is ACTIVE and the day is inside its range (the range is half open: the last day is the day before `validUntil`). */
export const holdsOn = (mapping: Pick<CodeMapping, 'status' | 'validFrom' | 'validUntil'>, day: string): boolean =>
  mapping.status === 'ACTIVE' && mapping.validFrom <= day && (mapping.validUntil === null || day < mapping.validUntil);

export type ResolutionVia = 'CROSSWALK' | 'DIRECT';

export interface InboundResolution {
  projectId: string | null;
  via: ResolutionVia | null;
  /** Both ways named a project and they differ: the crosswalk won. The proposal of a mapping refuses to create this (see `assertMappingKeepsHistory`), so it signals a mapping made before the guard or by hand. */
  shadowsDirect: boolean;
}

/**
 * The project a code of the other system stands for: the ACTIVE mapping that holds on `day` first; with none, the project whose own code is the same text, while the fallback lasts; else nobody (the record is kept and
 * the reconciliation reports it as a difference with an owner, as before).
 */
export function resolveInbound(input: { mappings: readonly CodeMapping[]; sourceSystem: string; externalCode: string; day: string; directProjectId: string | null }, options: { directFallback?: boolean } = {}): InboundResolution {
  const fallback = options.directFallback ?? DIRECT_MATCH_FALLBACK;
  const mapped = input.mappings.find((mapping) => mapping.sourceSystem === input.sourceSystem && mapping.externalCode === input.externalCode && holdsOn(mapping, input.day));
  if (mapped !== undefined) return { projectId: mapped.projectId, via: 'CROSSWALK', shadowsDirect: input.directProjectId !== null && input.directProjectId !== mapped.projectId };
  if (fallback && input.directProjectId !== null) return { projectId: input.directProjectId, via: 'DIRECT', shadowsDirect: false };
  return { projectId: null, via: null, shadowsDirect: false };
}

export interface OutboundResolution {
  /** The code the other system knows the project by. With no mapping it is our own code, sent under the fallback and flagged. */
  code: string;
  via: ResolutionVia | 'UNMAPPED';
}

/** The code a project goes under in the other system on `day`: its ACTIVE mapping; else, while the fallback lasts, its own code (flagged `DIRECT`); else it has none (`UNMAPPED`, the package says so). */
export function resolveOutbound(input: { mappings: readonly CodeMapping[]; sourceSystem: string; projectId: string; ourCode: string; day: string }, options: { directFallback?: boolean } = {}): OutboundResolution {
  const fallback = options.directFallback ?? DIRECT_MATCH_FALLBACK;
  const mapped = input.mappings.find((mapping) => mapping.projectId === input.projectId && mapping.sourceSystem === input.sourceSystem && holdsOn(mapping, input.day));
  if (mapped !== undefined) return { code: mapped.externalCode, via: 'CROSSWALK' };
  return fallback ? { code: input.ourCode, via: 'DIRECT' } : { code: '', via: 'UNMAPPED' };
}

/**
 * Whether a proposed mapping would change what an earlier reading meant: its external code is, as text, the code of a project that is not the one it is mapped to. The direct match read it as that other project before
 * and the crosswalk would now read it as this one, quietly moving the history of the reconciliation. Returns the project that would be shadowed, or null when the mapping is safe.
 */
export function shadowedProject(input: { externalCode: string; projectId: string; directProjectId: string | null }): string | null {
  return input.directProjectId !== null && input.directProjectId !== input.projectId ? input.directProjectId : null;
}
