import { unresolvedUnits } from '../process/model';
import type { Suggestion } from '../process/model';

export interface UnitsResolution {
  /** Every unit_ref of the template, as the server read it for this project. */
  refs: readonly string[];
  /** The refs the project cannot name: each is chosen from the unit tree before the workflow starts (R61). */
  unresolved: readonly string[];
  /** The unresolved refs nobody has chosen a unit for yet, each by the name the template gives the party (else its code): what the person still has to do. */
  missing: readonly string[];
  /** Refs of the template that point at a unit no longer in force: the start would be refused (PWF_UNIT_UNKNOWN). */
  unknown: readonly string[];
}

/** What the unit step stands on: the references, the ones that are open, and which of them are still empty in the form. */
export function unitsResolution(suggestion: Suggestion | undefined, chosen: Readonly<Record<string, string>>): UnitsResolution {
  const units = suggestion?.preview?.units;
  const unresolved = unresolvedUnits(suggestion);
  const names = new Map((units?.refs ?? []).map((row) => [row.unit_ref, row.party_name ?? row.unit_ref.replace('PROJECT_PARTY:', '')]));
  return {
    refs: (units?.refs ?? []).map((row) => row.unit_ref),
    unresolved,
    missing: unresolved.filter((ref) => (chosen[ref] ?? '').trim() === '').map((ref) => names.get(ref) ?? ref),
    unknown: units?.unknown ?? [],
  };
}
