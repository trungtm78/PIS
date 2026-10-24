import { randomUUID } from 'node:crypto';
import { DomainError, addDecimal, asUuid, assertFourEyes, compareDecimal, subtractDecimal, versionConflict, vietnamDateOf } from '@machvon/kernel';
import { lockLedgerRows } from './ledger-lock.ts';
import {
  appropriationIdsOf,
  assertYearsOpen,
  flowLines,
  lineKey,
  lockAppropriationRows,
  lockPlans,
  peekPlan,
  publishedRevisions,
  setVersionStatus,
  unitOf,
  yearsOf,
} from './cap-plan-locks.ts';
import type { FlowLine, LockedAppropriation, PlanRow } from './cap-plan-locks.ts';
import type { PlanAuthorizer } from './cap-plan-approval-store.ts';
import { MasterRules } from './master-rules.ts';
import { nationalCodeReading } from './prj-stage-store.ts';
import { usableDocumentId } from './prj-stage-support.ts';
import type { TenantTx } from './tenant-database.ts';

export interface CapPublishInput {
  decisionDocumentId: string;
  /** When the plan takes effect; the moment of the publication when it is not given. */
  effectiveAt?: string | undefined;
}

export type PostedEntryType = 'ALLOCATE' | 'REDUCE';

/** One entry the publication appended to the capital ledger. */
export interface LedgerPosting {
  entryId: string;
  entryType: PostedEntryType;
  allocationLineId: string;
  projectId: string;
  appropriationId: string;
  amountVnd: string;
}

export interface PublishResult {
  planId: string;
  version: number;
  revision: number;
  planYear: number | null;
  /** The revision this publication replaced; null for the first revision of a plan code. */
  supersededId: string | null;
  decisionDocumentId: string;
  effectiveAt: string;
  lineCount: number;
  ledger: LedgerPosting[];
  allocateVnd: string;
  reduceVnd: string;
  /** What the lines of the replaced revision held (their balances) and what the lines of the new revision hold, exactly. */
  totalBeforeVnd: string;
  totalAfterVnd: string;
  /** The funded projects of the pipeline whose national project code the rule only warns about. */
  nationalCodeWarnings: string[];
}

/** One line whose new amount is below what is already committed and disbursed on it (BR-CAP-05). */
export interface BelowCommitted {
  lineId: string;
  projectId: string;
  allocatedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
  minimumVnd: string;
}

/** A project and appropriation whose balances do not equal what the ledger says was allocated to them. */
export interface BalanceDrift {
  projectId: string;
  appropriationId: string;
  ledgerVnd: string;
  balanceVnd: string;
}

/** Thrown when the balances and the ledger disagree after a publication: nothing of the publication stays, and the total of the disagreement is what the metric reports. */
export class BalanceDriftError extends Error {
  readonly drift: readonly BalanceDrift[];

  constructor(drift: readonly BalanceDrift[]) {
    super('the ledger and the balances disagree after the publication of a capital plan');
    this.name = 'BalanceDriftError';
    this.drift = drift;
  }

  /** The sum of the differences, whichever way they go. */
  get totalVnd(): string {
    return this.drift.reduce((total, row) => addDecimal(total, compareDecimal(row.ledgerVnd, row.balanceVnd) > 0 ? subtractDecimal(row.ledgerVnd, row.balanceVnd) : subtractDecimal(row.balanceVnd, row.ledgerVnd)), '0');
  }
}

interface BalanceRow {
  id: string;
  allocationLineId: string;
  allocatedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
}

interface BalanceSql {
  id: string;
  allocation_line_id: string;
  allocated_vnd: string;
  committed_vnd: string;
  disbursed_vnd: string;
}

interface Planned {
  /** The balance row as it ends: its line, its allocated amount. */
  balance: { id: string | undefined; lineId: string; allocatedVnd: string; movedFromLineId: string | undefined };
  posting: { type: PostedEntryType; lineId: string; amountVnd: string } | undefined;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const floorOf = (balance: BalanceRow): string => addDecimal(balance.committedVnd, balance.disbursedVnd);

/** The effects of the entry types that move the allocated amount of a line; a reversal has the opposite effect of the entry it reverses. */
const ALLOCATED_EFFECT_SQL = `(values ('ALLOCATE', 1), ('REDUCE', -1), ('TRANSFER_IN', 1), ('TRANSFER_OUT', -1), ('EXTEND_IN', 1), ('EXTEND_OUT', -1)) as effect(entry_type, sign)`;

function instantOf(value: string): string {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) throw invalid('effective_at');
  return moment.toISOString();
}

/**
 * The publication of the capital plan (ST-CAP-003, CAP 3.1 F2 step 5, BR-CAP-05): an APPROVED revision, backed by a decision document, becomes the
 * plan in force. In one transaction the revision it replaces is SUPERSEDED, the entries ALLOCATE and REDUCE (by the difference to the replaced
 * revision) are appended to the capital ledger, and the balance of every line is created or moved to the new line and set to the new amount. No
 * line may end below what is already committed and disbursed on it. The locks are the plan rows by id (the new revision and the one it replaces),
 * the appropriation rows by id and then the balance rows in the order of `lockLedgerRows`, the order of the drafting, so two publications, or a
 * publication and a draft or a commitment, never wait for each other in a cycle.
 *
 * The allocated total of an appropriation is not written here: the ceiling was taken when the lines were drafted (a revision counts only its
 * difference to the revision it replaces), so replacing that revision leaves the total exactly as the live plans define it.
 */
export class CapPlanPublicationStore {
  private readonly rules = new MasterRules();

  async publish(
    tx: TenantTx,
    planId: string,
    expectedVersion: number,
    input: CapPublishInput,
    publisher: string,
    authorize: PlanAuthorizer,
    today: string = vietnamDateOf(new Date()),
    now: Date = new Date(),
  ): Promise<PublishResult> {
    const documentId = asUuid(input.decisionDocumentId);
    if (documentId === undefined) throw invalid('decision_document_id');
    const effectiveAt = input.effectiveAt === undefined ? now.toISOString() : instantOf(input.effectiveAt);

    const peek = await peekPlan(tx, planId);
    authorize(await unitOf(tx, peek.scopeUnitId));
    const others = await publishedRevisions(tx, peek.planCode, peek.id);
    const locked = await lockPlans(tx, [peek.id, ...others]);
    const plan = locked.find((candidate) => candidate.id === peek.id);
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version, { status: plan.status, updated_at: plan.updatedAt });
    assertFourEyes(plan.createdBy, publisher);
    if (plan.submittedBy !== null) assertFourEyes(plan.submittedBy, publisher);
    if (plan.status !== 'APPROVED') throw new DomainError('PLAN_NOT_APPROVED', 409, 'status');
    const previous = await this.replacedRevision(tx, plan, others, locked);
    await usableDocumentId(tx, documentId, 'decision_document_id');
    if (previous !== undefined && previous.effectiveAt !== null && new Date(effectiveAt) < new Date(previous.effectiveAt)) throw invalid('effective_at');

    const { lines, previousLines, appropriations } = await this.linesUnderLocks(tx, plan, previous);
    await assertYearsOpen(tx, yearsOf(plan, appropriations));
    const nationalCodeWarnings = await this.assertNationalCodes(tx, lines, today);

    const balances = await this.lockedBalances(tx, previousLines);
    const planned = this.plan(lines, previousLines, balances);

    if (previous !== undefined) {
      await tx.query("update machvon.capital_plan set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [previous.id, publisher]);
      await setVersionStatus(tx, previous.id, 'SUPERSEDED', publisher);
    }
    await tx.query(
      `update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = $2::uuid, effective_at = $3::timestamptz, published_at = now(), published_by = $4::uuid,
              updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [plan.id, documentId, effectiveAt, publisher],
    );
    await tx.query(
      `update machvon.plan_version set status = 'PUBLISHED', decision_id = $2::uuid, effective_at = $3::timestamptz, approved_by = $4::uuid, published_at = now(),
              updated_at = now(), updated_by = $5::uuid, version = version + 1 where capital_plan_id = $1::uuid`,
      [plan.id, documentId, effectiveAt, plan.approvedBy, publisher],
    );
    if (previous !== undefined) {
      await tx.query(
        `update machvon.plan_version old set superseded_by_id = new.id
           from machvon.plan_version new where old.tenant_id = new.tenant_id and old.capital_plan_id = $1::uuid and new.capital_plan_id = $2::uuid and old.project_id = new.project_id`,
        [previous.id, plan.id],
      );
    }

    const ledger = await this.apply(tx, plan, planned, [...lines, ...previousLines], appropriations, publisher);
    const touched = [...new Set([...lines, ...previousLines].map((line) => line.projectId))];
    const drift = await this.balanceDrift(tx, touched);
    // The ledger and the balances were written together: if they disagree now, nothing of the publication may stay.
    if (drift.length > 0) throw new BalanceDriftError(drift);

    const sum = (type: PostedEntryType): string => ledger.filter((entry) => entry.entryType === type).reduce((total, entry) => addDecimal(total, entry.amountVnd), '0');
    return {
      planId: plan.id,
      version: plan.version + 1,
      revision: plan.revision,
      planYear: plan.planYear,
      supersededId: previous?.id ?? null,
      decisionDocumentId: documentId,
      effectiveAt,
      lineCount: lines.length,
      ledger,
      allocateVnd: sum('ALLOCATE'),
      reduceVnd: sum('REDUCE'),
      totalBeforeVnd: balances.reduce((total, balance) => addDecimal(total, balance.allocatedVnd), '0'),
      totalAfterVnd: lines.reduce((total, line) => addDecimal(total, line.amountVnd), '0'),
      nationalCodeWarnings,
    };
  }

  /**
   * The projects and appropriations whose balances differ from the ledger: for each, the allocated amount the ledger entries net to (ALLOCATE and REDUCE,
   * TRANSFER and EXTEND pairs, a reversal undoing the entry it names) against the sum of the allocated amount of the balances of its lines. An empty
   * list is the invariant `cap_balance_drift_vnd = 0`; the nightly balance reconciliation reads the same. `projectIds` narrows the check.
   */
  async balanceDrift(tx: TenantTx, projectIds?: readonly string[]): Promise<BalanceDrift[]> {
    const rows = await tx.query<{ project_id: string; appropriation_id: string; ledger_vnd: string; balance_vnd: string }>(
      `with ledger as (
         select l.project_id, l.appropriation_id, sum(case when e.entry_type = 'REVERSAL' then -effect.sign else effect.sign end * e.amount_vnd) as total
           from machvon.capital_ledger_entry e
           left join machvon.capital_ledger_entry original on original.tenant_id = e.tenant_id and original.id = e.reversal_of_id
           join ${ALLOCATED_EFFECT_SQL} on effect.entry_type = coalesce(original.entry_type, e.entry_type)
           join machvon.allocation_line l on l.tenant_id = e.tenant_id and l.id = e.allocation_line_id
          group by l.project_id, l.appropriation_id
       ), held as (
         select l.project_id, l.appropriation_id, sum(b.allocated_vnd) as total
           from machvon.allocation_balance b join machvon.allocation_line l on l.tenant_id = b.tenant_id and l.id = b.allocation_line_id
          group by l.project_id, l.appropriation_id
       )
       select coalesce(ledger.project_id, held.project_id) as project_id, coalesce(ledger.appropriation_id, held.appropriation_id) as appropriation_id,
              coalesce(ledger.total, 0)::text as ledger_vnd, coalesce(held.total, 0)::text as balance_vnd
         from ledger full join held on held.project_id = ledger.project_id and held.appropriation_id = ledger.appropriation_id
        where coalesce(ledger.total, 0) <> coalesce(held.total, 0) and ($1::uuid[] is null or coalesce(ledger.project_id, held.project_id) = any($1::uuid[]))
        order by 1, 2`,
      [projectIds === undefined ? null : [...projectIds]],
    );
    return rows.map((row) => ({ projectId: row.project_id, appropriationId: row.appropriation_id, ledgerVnd: row.ledger_vnd, balanceVnd: row.balance_vnd }));
  }

  /**
   * The revision this one replaces, with its row locked: the PUBLISHED revision of the plan code. A revision names the one it was made from
   * (`supersedes_id`); if that one is no longer the published revision, or a first revision finds a published one, the plan was changed since the
   * revision was made and it is not published over it (409 PLAN_CHANGED_SINCE_PROPOSAL).
   */
  private async replacedRevision(tx: TenantTx, plan: PlanRow, peeked: readonly string[], locked: readonly PlanRow[]): Promise<PlanRow | undefined> {
    const published = await publishedRevisions(tx, plan.planCode, plan.id);
    if (published.some((id) => !peeked.includes(id)) || published.length > 1) throw new DomainError('PLAN_CHANGED_SINCE_PROPOSAL', 409, 'supersedes_id');
    const previous = locked.find((candidate) => candidate.id === published[0]);
    if ((plan.supersedesId ?? null) !== (previous?.id ?? null)) throw new DomainError('PLAN_CHANGED_SINCE_PROPOSAL', 409, 'supersedes_id');
    return previous;
  }

  /**
   * The lines of the plan and of the revision it replaces, read again once the appropriations are locked: a revision of an appropriation published
   * meanwhile moved the lines to itself, and the entries must name the appropriation the lines are on now.
   */
  private async linesUnderLocks(
    tx: TenantTx,
    plan: PlanRow,
    previous: PlanRow | undefined,
  ): Promise<{ lines: FlowLine[]; previousLines: FlowLine[]; appropriations: Map<string, LockedAppropriation> }> {
    const read = async (): Promise<{ lines: FlowLine[]; previousLines: FlowLine[] }> => ({ lines: await flowLines(tx, plan.id), previousLines: previous === undefined ? [] : await flowLines(tx, previous.id) });
    const peeked = await read();
    if (peeked.lines.length === 0 || peeked.lines.some((line) => line.appropriationId === null || line.projectId === '')) throw invalid('lines');
    const appropriations = await lockAppropriationRows(tx, appropriationIdsOf([...peeked.lines, ...peeked.previousLines]));
    const read2 = await read();
    const moved = (before: readonly FlowLine[], after: readonly FlowLine[]): boolean => before.length !== after.length || before.some((line, index) => line.id !== after[index]?.id || line.appropriationId !== after[index]?.appropriationId);
    if (moved(peeked.lines, read2.lines) || moved(peeked.previousLines, read2.previousLines)) throw versionConflict(plan.version, { status: plan.status, updated_at: plan.updatedAt });
    for (const line of read2.lines) {
      if (appropriations.get(line.appropriationId as string)?.status !== 'PUBLISHED') throw new DomainError('APPROPRIATION_NOT_PUBLISHED', 422, 'lines', { extensions: { line_id: line.id } });
    }
    return { ...read2, appropriations };
  }

  /**
   * The rule on the national project code (CXN-01, BR-PRJ-02): a project of the pipeline that has a funded line becomes BUDGETED by this publication,
   * and the rule of the day says whether it may do so without a code of the right form. The rule that blocks refuses the publication and names the
   * projects; the rule that warns lets it through and the projects are returned for the audit row.
   */
  private async assertNationalCodes(tx: TenantTx, lines: readonly FlowLine[], today: string): Promise<string[]> {
    const rule = await this.rules.nationalCode(tx, today);
    if (rule === undefined) return [];
    const projectIds = [...new Set(lines.map((line) => line.projectId))];
    const projects = await tx.query<{ id: string; national_project_code: string | null }>(
      "select id, national_project_code from machvon.project where id = any($1::uuid[]) and status = 'PIPELINE' order by id",
      [projectIds],
    );
    const refused: Array<{ id: string; code: string }> = [];
    const warned: string[] = [];
    for (const project of projects) {
      const reading = nationalCodeReading(rule, 'BUDGETED', project.national_project_code);
      if (reading.state === 'UNMET' && reading.refusal !== undefined) refused.push({ id: project.id, code: reading.refusal.code });
      else if (reading.state === 'WARNING') warned.push(project.id);
    }
    const first = refused[0];
    if (first !== undefined) throw new DomainError(first.code, 422, 'national_project_code', { extensions: { project_ids: refused.map((project) => project.id) } });
    return warned;
  }

  /** Locks the balances of the lines of the replaced revision in the one ledger lock order and reads them under the lock. */
  private async lockedBalances(tx: TenantTx, previousLines: readonly FlowLine[]): Promise<BalanceRow[]> {
    if (previousLines.length === 0) return [];
    const ids = await tx.query<{ id: string }>('select id from machvon.allocation_balance where allocation_line_id = any($1::uuid[])', [previousLines.map((line) => line.id)]);
    await lockLedgerRows(tx, ids.map((row) => ({ table: 'allocation_balance', id: row.id })));
    const rows = await tx.query<BalanceSql>(
      `select id, allocation_line_id, allocated_vnd::text as allocated_vnd, committed_vnd::text as committed_vnd, disbursed_vnd::text as disbursed_vnd
         from machvon.allocation_balance where allocation_line_id = any($1::uuid[]) order by id`,
      [previousLines.map((line) => line.id)],
    );
    return rows.map((row) => ({ id: row.id, allocationLineId: row.allocation_line_id, allocatedVnd: row.allocated_vnd, committedVnd: row.committed_vnd, disbursedVnd: row.disbursed_vnd }));
  }

  /**
   * What the publication does to the balances and the ledger, judged before anything is written. A line of the new revision takes the balance of the
   * line it replaces (same project, appropriation, bucket and source year) and moves it to the new amount; a line without a predecessor starts a balance;
   * a line the new revision drops is reduced to nothing. A line that would end below what is committed and disbursed on it refuses the whole publication
   * (422 REVISED_BELOW_COMMITTED), and every such line is listed.
   */
  private plan(lines: readonly FlowLine[], previousLines: readonly FlowLine[], balances: readonly BalanceRow[]): Planned[] {
    const balanceOf = new Map(balances.map((balance) => [balance.allocationLineId, balance]));
    const previousByKey = new Map(previousLines.map((line) => [lineKey(line), line]));
    const matched = new Set<string>();
    const planned: Planned[] = [];
    const below: BelowCommitted[] = [];
    const check = (balance: BalanceRow, lineId: string, projectId: string, allocated: string): boolean => {
      const minimum = floorOf(balance);
      if (compareDecimal(allocated, minimum) >= 0) return true;
      below.push({ lineId, projectId, allocatedVnd: allocated, committedVnd: balance.committedVnd, disbursedVnd: balance.disbursedVnd, minimumVnd: minimum });
      return false;
    };
    for (const line of lines) {
      const replaced = previousByKey.get(lineKey(line));
      if (replaced !== undefined) matched.add(replaced.id);
      const balance = replaced === undefined ? undefined : balanceOf.get(replaced.id);
      if (balance === undefined) {
        planned.push({ balance: { id: undefined, lineId: line.id, allocatedVnd: line.amountVnd, movedFromLineId: undefined }, posting: { type: 'ALLOCATE', lineId: line.id, amountVnd: line.amountVnd } });
        continue;
      }
      if (!check(balance, line.id, line.projectId, line.amountVnd)) continue;
      const change = compareDecimal(line.amountVnd, balance.allocatedVnd);
      const posting = change === 0 ? undefined : { type: (change > 0 ? 'ALLOCATE' : 'REDUCE') as PostedEntryType, lineId: line.id, amountVnd: change > 0 ? subtractDecimal(line.amountVnd, balance.allocatedVnd) : subtractDecimal(balance.allocatedVnd, line.amountVnd) };
      planned.push({ balance: { id: balance.id, lineId: line.id, allocatedVnd: line.amountVnd, movedFromLineId: balance.allocationLineId }, posting });
    }
    for (const dropped of previousLines.filter((line) => !matched.has(line.id))) {
      const balance = balanceOf.get(dropped.id);
      if (balance === undefined || !check(balance, dropped.id, dropped.projectId, '0')) continue;
      if (compareDecimal(balance.allocatedVnd, '0') === 0) continue;
      planned.push({ balance: { id: balance.id, lineId: dropped.id, allocatedVnd: '0', movedFromLineId: undefined }, posting: { type: 'REDUCE', lineId: dropped.id, amountVnd: balance.allocatedVnd } });
    }
    if (below.length > 0) {
      const listed = [...below].sort((a, b) => (a.lineId < b.lineId ? -1 : 1)).map((line) => ({
        line_id: line.lineId,
        project_id: line.projectId,
        allocated_vnd: line.allocatedVnd,
        committed_vnd: line.committedVnd,
        disbursed_vnd: line.disbursedVnd,
        minimum_vnd: line.minimumVnd,
      }));
      throw new DomainError('REVISED_BELOW_COMMITTED', 422, 'lines', { extensions: { lines: listed } });
    }
    return planned;
  }

  /** Writes the balances and appends the entries, in the order of the lines, and has the active reservations follow a balance that moved to a new line. */
  private async apply(
    tx: TenantTx,
    plan: PlanRow,
    planned: readonly Planned[],
    lines: readonly FlowLine[],
    appropriations: ReadonlyMap<string, LockedAppropriation>,
    actor: string,
  ): Promise<LedgerPosting[]> {
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const ledger: LedgerPosting[] = [];
    for (const step of [...planned].sort((a, b) => (a.balance.lineId < b.balance.lineId ? -1 : 1))) {
      const { balance } = step;
      if (balance.id === undefined) {
        await tx.query(
          `insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::numeric, 0, 0, 0)`,
          [randomUUID(), balance.lineId, balance.allocatedVnd],
        );
      } else {
        await tx.query('update machvon.allocation_balance set allocation_line_id = $2::uuid, allocated_vnd = $3::numeric, updated_at = now(), version = version + 1 where id = $1::uuid', [balance.id, balance.lineId, balance.allocatedVnd]);
        if (balance.movedFromLineId !== undefined && balance.movedFromLineId !== balance.lineId) {
          await tx.query("update machvon.fund_reservation set allocation_line_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where allocation_line_id = $1::uuid and status = 'ACTIVE'", [balance.movedFromLineId, balance.lineId, actor]);
        }
      }
      if (step.posting === undefined) continue;
      const line = lineById.get(step.posting.lineId);
      const appropriationId = line?.appropriationId;
      if (line === undefined || appropriationId === null || appropriationId === undefined) throw new Error('a posted line has no appropriation');
      const entryId = randomUUID();
      await tx.query(
        `insert into machvon.capital_ledger_entry
           (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::integer, 'CAPITAL_PLAN', $8::uuid, $9::uuid)`,
        [entryId, appropriationId, line.id, line.projectId, step.posting.type, step.posting.amountVnd, appropriations.get(appropriationId)?.planYear, plan.id, actor],
      );
      ledger.push({ entryId, entryType: step.posting.type, allocationLineId: line.id, projectId: line.projectId, appropriationId, amountVnd: step.posting.amountVnd });
    }
    return ledger;
  }
}
