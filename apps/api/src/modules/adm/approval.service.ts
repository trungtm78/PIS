import { Inject, Injectable } from '@nestjs/common';
import { ApprovalStore } from '@machvon/db';
import type { ApprovalEffects, ApprovalStartInput, FinalCommand, WorkflowInstanceRecord } from '@machvon/db';
import { BUSINESS_TYPES } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';

/** The commands the owning modules register for a business type: the end of a workflow calls one of them. */
export const APPROVAL_FINAL_COMMANDS = Symbol('APPROVAL_FINAL_COMMANDS');

/**
 * The final commands by business type (ADM 3.7 item 6). A module registers the handler of its business type; the handler runs the domain command in the transaction of the decision, with the idempotency key of the
 * instance, and answers `GUARD_REJECTED` when the transition table of the domain refuses it (BR-ADM-07). Until the owning module registers its own, a business type is bound to a test double that accepts.
 */
export class FinalCommandRegistry {
  private readonly handlers = new Map<string, FinalCommand>();

  constructor() {
    for (const type of BUSINESS_TYPES) this.handlers.set(type.code, () => Promise.resolve('APPLIED'));
  }

  /** Binds the real handler of a business type, replacing the test double. */
  register(businessType: string, handler: FinalCommand): void {
    if (!BUSINESS_TYPES.some((type) => type.code === businessType)) throw new Error(`${businessType} is not a registered business type`);
    this.handlers.set(businessType, handler);
  }

  handlerOf(businessType: string): FinalCommand {
    const handler = this.handlers.get(businessType);
    if (handler === undefined) throw new Error(`no final command is registered for ${businessType}`);
    return handler;
  }

  /** The handler the engine calls for whatever business type the instance is of. */
  asFinalCommand(): FinalCommand {
    return (call) => this.handlerOf(call.instance.businessType)(call);
  }
}

/** The audit trail and the events of a command scope, as the engine writes them. */
export function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * `ApprovalService` (ADM 3.7): what a business module calls inside the transaction that submits a record. `start` writes the running instance, pinned to the published definition and the matrix in force, and gives the first step its
 * tasks, all in the caller's transaction: a failure (no workflow configured, no DoA rule, no approver) rolls the submit back and the record stays a draft. `cancel` ends the running instance when the record is withdrawn.
 */
@Injectable()
export class ApprovalService {
  private readonly store = new ApprovalStore();

  constructor(@Inject(APPROVAL_FINAL_COMMANDS) readonly commands: FinalCommandRegistry) {}

  start(scope: CommandScope, input: Omit<ApprovalStartInput, 'initiatorMembershipId' | 'now'> & { initiatorMembershipId?: string; now?: Date }): Promise<WorkflowInstanceRecord> {
    return this.store.start(scope.tx, effectsOf(scope), { ...input, initiatorMembershipId: input.initiatorMembershipId ?? scope.tenant.membershipId, now: input.now ?? new Date() });
  }

  cancel(scope: CommandScope, input: { resourceType: string; resourceId: string; reason: string; now?: Date }): Promise<boolean> {
    return this.store.cancel(scope.tx, effectsOf(scope), { ...input, now: input.now ?? new Date() });
  }
}
