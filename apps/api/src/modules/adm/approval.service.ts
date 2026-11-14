import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ApprovalStore } from '@machvon/db';
import type { ApprovalEffects, ApprovalStartInput, FinalCommand, TenantTx, WorkflowInstanceRecord } from '@machvon/db';
import { BUSINESS_TYPES, DomainError, enabledBusinessTypes, testDoublesAllowed } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { ADM_MOUNTED_MODULES } from './tokens';

/** The record a task is about, as the engine knows it: enough for the owning module to find it. */
export interface ApprovalSummarySubject {
  businessType: string;
  resourceType: string;
  resourceId: string;
  unitId: string;
}

/**
 * What an approver reads of the record before deciding (`ApprovalRecordSummary` of openapi.json): who it is about, who sent it, the unit, the project and the period it belongs to, a few named facts and the text of the
 * request. Codes and values, never a sentence: the screen words them.
 */
export interface ApprovalRecordSummary {
  kind: string;
  subject: { name: string | null } | null;
  unit: { id: string; code: string | null; name: string | null } | null;
  project: { id: string; code: string; name: string } | null;
  period: { from: string; to: string; status: string } | null;
  facts: Array<{ code: string; value: string | number | null }>;
  body: string | null;
  target: { screen: string; id: string } | null;
}

export type ApprovalSummaryReader = (tx: TenantTx, task: ApprovalSummarySubject) => Promise<ApprovalRecordSummary | undefined>;

/** The commands the owning modules register for a business type: the end of a workflow calls one of them. */
export const APPROVAL_FINAL_COMMANDS = Symbol('APPROVAL_FINAL_COMMANDS');

export interface FinalCommandRegistryOptions {
  /** Bind every business type to a double that accepts. Only a test build may ask for it (R14): anywhere else the constructor refuses. */
  testDoubles?: boolean;
  /** The process environment the build is judged from (`NODE_ENV`). */
  variables?: Readonly<Record<string, string | undefined>>;
}

/**
 * The final commands by business type (ADM 3.7 item 6). A module registers the handler of its business type; the handler runs the domain command in the transaction of the decision, with the idempotency key of the
 * instance, and answers `GUARD_REJECTED` when the transition table of the domain refuses it (BR-ADM-07). In a test build every business type that has no handler of its own is bound to a double that accepts, so
 * that the engine can be tested alone; in any other build there is no double: a business type without a real handler cannot start an instance, and `assertBootable` stops the process that enables one (R14).
 */
export class FinalCommandRegistry {
  private readonly handlers = new Map<string, FinalCommand>();
  private readonly real = new Set<string>();
  private readonly summaries = new Map<string, ApprovalSummaryReader>();

  constructor(options: FinalCommandRegistryOptions = {}) {
    const variables = options.variables ?? process.env;
    const doubles = options.testDoubles ?? testDoublesAllowed(variables);
    if (doubles && !testDoublesAllowed(variables)) throw new Error('the test doubles of the final commands exist only in a test build');
    if (doubles) for (const type of BUSINESS_TYPES) this.handlers.set(type.code, () => Promise.resolve('APPLIED'));
  }

  /** Binds the real handler of a business type, replacing the test double. */
  register(businessType: string, handler: FinalCommand): void {
    if (!BUSINESS_TYPES.some((type) => type.code === businessType)) throw new Error(`${businessType} is not a registered business type`);
    this.handlers.set(businessType, handler);
    this.real.add(businessType);
  }

  /**
   * Binds what the person who decides a task of the business type reads of the record before deciding (lane fix11): the owning module says it, as it says the final command. A business type with no reader has no
   * summary, and its task is shown as before (the type, the step, the amount, the unit).
   */
  registerSummary(businessType: string, reader: ApprovalSummaryReader): void {
    if (!BUSINESS_TYPES.some((type) => type.code === businessType)) throw new Error(`${businessType} is not a registered business type`);
    this.summaries.set(businessType, reader);
  }

  /** The summary of the record of a task, or null when the owning module bound none or the record is not there. The reader of a module never fails the read of the task: a failure is no summary. */
  async summaryOf(tx: TenantTx, task: ApprovalSummarySubject): Promise<ApprovalRecordSummary | null> {
    const reader = this.summaries.get(task.businessType);
    if (reader === undefined) return null;
    return (await reader(tx, task)) ?? null;
  }

  /** Whether the owning module bound its own handler (a double does not count). */
  hasRealHandler(businessType: string): boolean {
    return this.real.has(businessType);
  }

  /** Whether the engine can end an instance of the business type: a real handler, or a double in a test build. */
  canHandle(businessType: string): boolean {
    return this.handlers.has(businessType);
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

  /** The enabled business types that have no real handler (in a test build a double stands in, so none). */
  missingHandlers(enabled: readonly string[], variables: Readonly<Record<string, string | undefined>> = process.env): string[] {
    return enabled.filter((code) => !this.real.has(code) && !(testDoublesAllowed(variables) && this.handlers.has(code)));
  }
}

/**
 * The guard of the boot (R14): a process that enables a business type whose owning module did not bind a real final command does not start. The failure names the types, so that a deployment never runs a
 * workflow that ends in nothing and reports it done.
 */
@Injectable()
export class ApprovalBootGuard implements OnApplicationBootstrap {
  constructor(
    @Inject(APPROVAL_FINAL_COMMANDS) private readonly commands: FinalCommandRegistry,
    @Optional() @Inject(ADM_MOUNTED_MODULES) private readonly mounted?: readonly string[],
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.commands.missingHandlers(enabledBusinessTypes(process.env, this.mounted));
    if (missing.length > 0) throw new Error(`approval workflows are enabled for business types that have no real final command: ${missing.join(', ')}`);
  }
}

/** The audit trail and the events of a command scope, as the engine writes them. */
export function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event), afterCommit: (callback) => scope.afterCommit(callback) };
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
    // A business type whose end nobody can run is not started: its record would wait for an approval that cannot be applied.
    if (!this.commands.canHandle(input.businessType)) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    return this.store.start(scope.tx, effectsOf(scope), { ...input, initiatorMembershipId: input.initiatorMembershipId ?? scope.tenant.membershipId, now: input.now ?? new Date() });
  }

  cancel(scope: CommandScope, input: { resourceType: string; resourceId: string; reason: string; now?: Date }): Promise<boolean> {
    return this.store.cancel(scope.tx, effectsOf(scope), { ...input, now: input.now ?? new Date() });
  }
}
