import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ApprovalStore } from '@machvon/db';
import type { ApprovalEffects, ApprovalStartInput, FinalCommand, TenantTx, WorkflowInstanceRecord } from '@machvon/db';
import { BUSINESS_TYPES, DomainError, enabledBusinessTypes, testDoublesAllowed } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
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

/** One way of deciding a pending record: the decision the screen offers and the operation of the owning module that carries it out. */
export interface PendingDecisionAction {
  decision: 'approve' | 'return' | 'reject';
  /** The operation of the contract the screen calls: the command of the owning module, with its own permission, scope, idempotency and audit. */
  operationId: string;
  /** Whether the command refuses the decision without words of the person (a return says why). */
  reasonRequired: boolean;
  /** The fewest and the most characters the command keeps of those words. */
  reasonMin: number;
  reasonMax: number;
}

/**
 * A record of a module that waits for the reader to decide it and is not a task of the engine (`PendingDecision` of openapi.json, PWF 20.9): nobody was assigned, whoever holds the permission of the command in the
 * scope of the record decides. The inbox lists it beside the tasks of the engine; the decision is the command of the owning module, never a second way of approving.
 */
export interface PendingDecision {
  id: string;
  kind: string;
  resource: { type: string; id: string };
  /** The version the command is sent under (`If-Match`). */
  version: number;
  submittedAt: string;
  initiatorName: string | null;
  /** The moment the decision is due, when the kind runs a clock; null when it has none. */
  dueAt: string | null;
  overdue: boolean;
  summary: ApprovalRecordSummary;
  actions: PendingDecisionAction[];
}

export interface PendingDecisionViewer {
  membershipId: string;
  access: EffectiveAccess;
  now: Date;
}

/** What a module answers for one reader: the records that wait for them, the oldest first, at most `limit`. */
export type PendingDecisionSource = (tx: TenantTx, viewer: PendingDecisionViewer, limit: number) => Promise<PendingDecision[]>;

/** The most records one source gives the inbox; a source that reaches it makes the answer say it is cut. */
export const PENDING_DECISION_LIMIT = 100;

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
  private readonly pending = new Map<string, PendingDecisionSource>();

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

  /**
   * Binds the reader of the records of a module that wait for a decision outside the engine (PWF 20.9): the module says which of its records wait for this reader, as it says the final command of its business types.
   * The code names the source in `unavailable_sources` when its read fails.
   */
  registerPendingSource(code: string, source: PendingDecisionSource): void {
    this.pending.set(code, source);
  }

  /**
   * What waits for the reader across the registered sources, the oldest first. A source that fails does not take the inbox with it: its statement is rolled back to a savepoint and the source is named, never shown
   * as "nothing waits".
   */
  async pendingOf(tx: TenantTx, viewer: PendingDecisionViewer, limit = PENDING_DECISION_LIMIT): Promise<{ items: PendingDecision[]; unavailableSources: string[]; truncated: boolean }> {
    const items: PendingDecision[] = [];
    const unavailableSources: string[] = [];
    let truncated = false;
    for (const [code, source] of this.pending) {
      await tx.query('savepoint adm_pending_source');
      try {
        const found = await source(tx, viewer, limit);
        await tx.query('release savepoint adm_pending_source');
        if (found.length >= limit) truncated = true;
        items.push(...found);
      } catch {
        await tx.query('rollback to savepoint adm_pending_source');
        await tx.query('release savepoint adm_pending_source');
        unavailableSources.push(code);
      }
    }
    items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
    return { items, unavailableSources, truncated };
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
