import { AuditWriter, SodGuard, SodRefusal } from '@machvon/db';
import type { SodPassed, SodSubjectKind, TenantDatabase } from '@machvon/db';
import type { CommandScope } from './command-scope';

/** The duty a command takes and the record it acted on: what a module tells the gate (`SOD_ACTIONS` of the kernel names the duties). */
export interface SodCommand {
  taking: string;
  subjectKind: SodSubjectKind;
  recordId: string;
  /** The operation id of the command. */
  command: string;
}

const guard = new SodGuard();

/**
 * The one line a command of CTR, PAY or BID adds (G4-1): called after the module has done its own work and before the answer, inside the command transaction, so a conflict that is refused (422 SOD_VIOLATION naming the two
 * duties of the pair) rolls back everything the command did, and a use of an exception or a warning is kept with the command. A refused attempt is written in transactions of its own after the rollback (`sod_exception_use`
 * as BLOCKED and the audit trail as DENIED), so the attempt survives. The matrix is read through the governance port; a source that cannot be read is 503 and the command is refused, never passed unread.
 */
export async function enforceSod(scope: CommandScope, database: TenantDatabase | undefined, take: SodCommand, now: Date = new Date()): Promise<SodPassed> {
  try {
    return await guard.assert(scope.tx, { ...take, actor: scope.tenant.membershipId, requestId: scope.requestId }, now);
  } catch (error) {
    if (error instanceof SodRefusal && database !== undefined) {
      const refusal = error;
      scope.afterRollback(async () => {
        await database.withTenant(scope.tenant, (tx) => guard.recordRefusal(tx, refusal));
        await new AuditWriter(database).recordDenied(scope.tenant, {
          action: 'sod.violation_blocked',
          resourceType: 'sod_exception',
          resourceId: refusal.attempt.take.recordId,
          classification: 'INTERNAL',
          diff: { command: take.command, taking: take.taking, action_a: refusal.attempt.check.action_a, action_b: refusal.attempt.check.action_b, scope: refusal.attempt.check.scope, rule_version: refusal.attempt.ruleVersion },
          correlationId: scope.correlationId,
          requestId: scope.requestId,
        });
      });
    }
    throw error;
  }
}
