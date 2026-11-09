import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApprovalStore } from '@machvon/db';
import type { ApprovalEffects, HoldHook, TenantTx, WorkflowInstanceRecord } from '@machvon/db';
import { holdStateAfterPush, pushLayoutCodeOf } from '@machvon/kernel';
import type { PushStatus, StagedOwner } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from './approval.service';
import type { FinalCommandRegistry } from './approval.service';

/** The receiver the PUSH step hands its package to (ENT-3c, R22): provided by the module of the edition that has one; absent, the PUSH step is the person step it has always been. */
export const APPROVAL_PUSH_PORT = Symbol('APPROVAL_PUSH_PORT');
/** The registry of what each owner of a staged approval hands over at its PUSH step. */
export const APPROVAL_PUSH_SOURCES = Symbol('APPROVAL_PUSH_SOURCES');

/** What an owner says about the record of an instance for the PUSH step: the series it belongs to, the revision, the facts of the package and the newest revision that exists (R17). */
export interface ApprovalPushSubject {
  /** The code of the record that names its series (a project code): one series per record, so two records never share a key. */
  subjectCode: string;
  period: string;
  revision: number;
  headRevision: number;
  facts: Readonly<Record<string, unknown>>;
}

export interface ApprovalPushSource {
  owner: StagedOwner;
  resourceType: string;
  /** The layout base the series is built from (`DIS_WEEKLY`). */
  layoutBase: string;
  /** Undefined when the record is gone: the step then cannot be held. */
  describe(tx: TenantTx, instance: WorkflowInstanceRecord): Promise<ApprovalPushSubject | undefined>;
}

export interface ApprovalPushCall {
  tenantId: string;
  actor: string;
  now: Date;
  /** The audit trail and the events of the transaction the step is decided in. */
  effects: ApprovalEffects;
  owner: StagedOwner;
  layoutCode: string;
  period: string;
  revision: number;
  headRevision: number;
  facts: Readonly<Record<string, unknown>>;
}

export interface ApprovalPushResult {
  pushId: string;
  key: string;
  status: PushStatus;
  errorCode: string | null;
}

/** The port itself: it builds the package, keys the push by organisation, layout, period and revision (R8) and refuses a revision older than the newest (R17); a failed delivery is an answer, a refusal throws. */
export interface ApprovalPushPort {
  push(tx: TenantTx, call: ApprovalPushCall): Promise<ApprovalPushResult>;
}

/** The sources of the PUSH step by the resource type of the instance. */
export class ApprovalPushSources {
  private readonly sources = new Map<string, ApprovalPushSource>();

  register(source: ApprovalPushSource): void {
    this.sources.set(source.resourceType, source);
  }

  of(resourceType: string): ApprovalPushSource | undefined {
    return this.sources.get(resourceType);
  }
}

/**
 * The PUSH step of the staged approval (ENT-3c, R22). With a receiver in the process, the approval that would complete the step hands the package over first: `hook` is what the engine calls, `receive` is what the
 * command that records the receipt calls. The task stays pending and the hold says "awaiting receipt" until the receiver answers; an acceptance finishes the decision of the person who held the step.
 */
@Injectable()
export class ApprovalHoldService {
  private readonly approvals = new ApprovalStore();

  constructor(
    @Inject(APPROVAL_FINAL_COMMANDS) private readonly commands: FinalCommandRegistry,
    @Optional() @Inject(APPROVAL_PUSH_PORT) private readonly port?: ApprovalPushPort,
    @Optional() @Inject(APPROVAL_PUSH_SOURCES) private readonly sources?: ApprovalPushSources,
  ) {}

  /** Whether this process has a receiver for the PUSH step. */
  get active(): boolean {
    return this.port !== undefined && this.sources !== undefined;
  }

  /** The hook the engine runs for the PUSH step, or undefined where there is no receiver. */
  hook(tenantId: string): HoldHook | undefined {
    const port = this.port;
    const sources = this.sources;
    if (port === undefined || sources === undefined) return undefined;
    return async ({ tx, instance, caller, now, effects }) => {
      const source = sources.of(instance.resourceType);
      if (source === undefined) return undefined;
      const subject = await source.describe(tx, instance);
      if (subject === undefined) return undefined;
      const result = await port.push(tx, {
        tenantId,
        actor: caller,
        now,
        effects,
        owner: source.owner,
        layoutCode: pushLayoutCodeOf(source.layoutBase, subject.subjectCode),
        period: subject.period,
        revision: subject.revision,
        headRevision: subject.headRevision,
        facts: subject.facts,
      });
      return { state: holdStateAfterPush(result.status), pushId: result.pushId, pushKey: result.key, pushStatus: result.status, resourceRevision: subject.revision };
    };
  }

  /**
   * The receiver answered the push: an acceptance finishes the decision of the held step (the final command of the owner runs once), a rejection ends the hold. Nothing happens for a push that is not a step of an
   * approval. Called in the transaction of the command that recorded the receipt.
   */
  receive(scope: CommandScope, input: { pushId: string; outcome: 'ACCEPTED' | 'REJECTED'; reference: string; now: Date }): ReturnType<ApprovalStore['answerHold']> {
    return this.approvals.answerHold(scope.tx, effectsOf(scope), { pushId: input.pushId, outcome: input.outcome, by: scope.tenant.membershipId, reference: input.reference, now: input.now, finish: this.commands.asFinalCommand() });
  }
}
