import { DomainError } from '@machvon/kernel';
import type { EventTypeEntry } from '@machvon/db';
import { definitionOf } from './definition';

/** The keys a notification workflow definition has (`definitionOf` reads the first seven; the reason belongs to the override of the quiet hours). */
const KEYS: readonly string[] = ['channels', 'resolver', 'priority', 'ackRequired', 'expiresAfterMinutes', 'purpose', 'quietHoursOverride', 'quietHoursOverrideReason'];
const MIN_OVERRIDE_REASON = 10;
const MAX_OVERRIDE_REASON = 500;

function invalid(field: string): DomainError {
  return new DomainError('WORKFLOW_DEFINITION_INVALID', 422, `definition.${field}`);
}

/**
 * Judges the definition of a notification workflow against the entry of the catalogue of its event type (NOT 3.1, BR-NOT-02, BR-NOT-15, NOT 3.4). Nothing is stored for a definition that is refused, and the answer names the first
 * field that is wrong (422 `WORKFLOW_DEFINITION_INVALID`), never a value:
 *  - only the keys of the definition (a misspelled key is not silently ignored);
 *  - the same values as the core reads at run time (`definitionOf`): the channels in the order they are tried (the fallback), the recipients, the priority, the acknowledgement, the expiry;
 *  - the purpose is one the event type allows;
 *  - the quiet hours are overridden only for a CRITICAL message, and only with a reason the audit can show.
 */
export function assertWorkflowDefinition(raw: unknown, entry: EventTypeEntry): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!KEYS.includes(key)) throw invalid(key);
  let definition;
  try {
    definition = definitionOf(record);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'VALIDATION_FAILED') throw invalid((error.detail ?? '').replace(/^workflow\.definition\./, ''));
    throw error;
  }
  if (!entry.allowedPurposes.includes(definition.purpose)) throw invalid('purpose');
  const reason = record.quietHoursOverrideReason;
  if (definition.quietHoursOverride) {
    if (typeof reason !== 'string' || reason.trim().length < MIN_OVERRIDE_REASON || reason.trim().length > MAX_OVERRIDE_REASON) throw invalid('quietHoursOverrideReason');
  } else if (reason !== undefined) {
    // A reason for an override that is not there would be read as consent to one.
    throw invalid('quietHoursOverrideReason');
  }
}
