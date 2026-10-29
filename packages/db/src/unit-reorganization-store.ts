import { DomainError, reorganizationSuccessorOf, unmappedByReorganization, versionConflict } from '@machvon/kernel';
import type { ReorganizationInput, ReorganizationKind } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import { createUnit, lockUnitTree } from './org-unit-tree.ts';
import type { CreateUnitInput } from './org-unit-tree.ts';
import { bumpScopeVersion } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The gauge of the reorganisations that stopped on a step and wait for someone to mend the cause and decide again (alert `ADM_UNIT_REORGANIZATION_FAILED`). */
export const REORGANIZATION_FAILED_GAUGE = 'unit_reorganization_failed_total';
/** The most steps one pass of the job takes for one reorganisation; the saga goes on in the next pass. */
export const REORGANIZATION_STEPS_PER_PASS = 200;
const OPEN_STATUSES = "('Draft', 'PendingApproval', 'Approved', 'Applying', 'Failed')";

/** The proposal as it is stored in `mapping_json` (a new successor is already in the form the unit tree creates it from). */
export interface StoredProposal {
  predecessor_unit_ids: string[];
  successors: Array<{ existing_unit_id?: string; new_unit?: CreateUnitInput }>;
  mapping: {
    memberships: Array<{ membership_id: string; successor_unit_id: string }>;
    projects: Array<{ project_id: string; successor_unit_id: string }>;
    default_successor_unit_id?: string;
  };
}

export type ReorganizationStatus = 'Draft' | 'PendingApproval' | 'Approved' | 'Applying' | 'Applied' | 'Failed' | 'Cancelled';

export interface ReorganizationRecord {
  id: string;
  kind: ReorganizationKind;
  effectiveFrom: string;
  legalBasisRef: string;
  status: ReorganizationStatus;
  proposal: StoredProposal;
  requestedBy: string;
  requestedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedAt: string | null;
  resultSummary: Record<string, unknown> | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

export interface UnitFact {
  id: string;
  code: string;
  name: string;
  status: string;
  validFrom: string;
  /** The day the unit ends (it does not stand on that day), if it has an end. */
  validUntil: string | null;
}

/** What the old units hold now, and what stands in the way of reorganising them. */
export interface ReorganizationFacts {
  units: UnitFact[];
  membershipIds: string[];
  projectIds: string[];
  /** Active child units that are not themselves predecessors: they would be left under a unit that stops existing. */
  strandedChildIds: string[];
  /** Predecessors that another reorganisation not yet over already names. */
  busyUnitIds: string[];
}

interface Row {
  id: string;
  kind: ReorganizationKind;
  effective_from: string;
  legal_basis_ref: string;
  status: ReorganizationStatus;
  mapping_json: StoredProposal;
  requested_by: string;
  requested_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  applied_at: string | null;
  result_summary: Record<string, unknown> | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const FROM = `machvon.unit_reorganization r
  left join machvon.tenant_user_directory rq on rq.tenant_id = r.tenant_id and rq.membership_id = r.requested_by
  left join machvon.tenant_user_directory ap on ap.tenant_id = r.tenant_id and ap.membership_id = r.approved_by`;
const COLUMNS = `r.id, r.kind, r.effective_from::text as effective_from, r.legal_basis_ref, r.status, r.mapping_json, r.requested_by, rq.display_name as requested_by_name, r.approved_by, ap.display_name as approved_by_name,
  ${TIME('r.decided_at')} as decided_at, r.decision_reason, ${TIME('r.applied_at')} as applied_at, r.result_summary, ${TIME('r.created_at')} as created_at, r.version::text as version, ${TIME('r.created_at')} as sort_key`;

const toRecord = (row: Row): ReorganizationRecord => ({
  id: row.id,
  kind: row.kind,
  effectiveFrom: row.effective_from,
  legalBasisRef: row.legal_basis_ref,
  status: row.status,
  proposal: row.mapping_json,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name,
  approvedBy: row.approved_by,
  approvedByName: row.approved_by_name,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  appliedAt: row.applied_at,
  resultSummary: row.result_summary,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

/** The proposal in the form the kernel judges it. */
export function inputOf(record: Pick<ReorganizationRecord, 'kind' | 'effectiveFrom' | 'proposal'>): ReorganizationInput {
  const { proposal } = record;
  return {
    kind: record.kind,
    effectiveFrom: record.effectiveFrom,
    predecessorIds: proposal.predecessor_unit_ids,
    successors: proposal.successors.map((successor) => ({ existingUnitId: successor.existing_unit_id, newUnit: successor.new_unit })),
    mapping: {
      memberships: proposal.mapping.memberships.map((entry) => ({ membershipId: entry.membership_id, successorUnitId: entry.successor_unit_id })),
      projects: proposal.mapping.projects.map((entry) => ({ projectId: entry.project_id, successorUnitId: entry.successor_unit_id })),
      defaultSuccessorUnitId: proposal.mapping.default_successor_unit_id,
    },
  };
}

/** What a project transfer needs from the module that owns projects (PRJ, XM-ADM-02): the project goes to the successor unit, under a key that makes a retry harmless. */
export interface ReorganizationProjectPort {
  transfer(tx: TenantTx, call: { reorganizationId: string; projectId: string; fromUnitId: string; toUnitId: string; effectiveFrom: string; idempotencyKey: string }): Promise<void>;
}

export type StepOutcome = { kind: 'STEP'; key: string } | { kind: 'APPLIED' } | { kind: 'WAITING' };

/**
 * The reorganisation of organisation units (ST-ADM-015, ADM 3.2): the proposal with its mapping, the decision, and the saga that carries it out one idempotent step at a time. Every step is its own transaction and leaves a row
 * (key \`reorg:{id}:{step}:{item}\`); what a step has done is also what keeps it from being found again, so a saga that failed and is decided again goes on from the step that failed and the steps done are skipped.
 */
export class UnitReorganizationStore {
  // ---- the proposal --------------------------------------------------------------------------------------------------------------

  async facts(tx: TenantTx, predecessorIds: readonly string[], successorIds: readonly string[], newParentIds: readonly string[] = []): Promise<ReorganizationFacts & { successors: UnitFact[] }> {
    const units = await this.unitsOf(tx, predecessorIds);
    const successors = await this.unitsOf(tx, successorIds);
    // Every live membership of the old units moves, the suspended and the invited too: a suspended member reactivated later must not become active in a unit that no longer exists.
    const members = await tx.query<{ id: string }>("select id from machvon.membership where organization_id = any($1::uuid[]) and status in ('Invited', 'Active', 'Suspended') order by id", [predecessorIds]);
    const projects = await tx.query<{ id: string }>("select id from machvon.project where owner_unit_id = any($1::uuid[]) and status <> 'CLOSED' order by id", [predecessorIds]);
    const stranded = await tx.query<{ id: string }>("select id from machvon.organization_unit where parent_id = any($1::uuid[]) and not (id = any($1::uuid[])) and status in ('Planned', 'Active') order by id", [predecessorIds]);
    // Another reorganisation that is not over holds a unit when it names it as an old unit, or when it takes over from it: an old unit of ours may not be an old unit or a successor of theirs, and a successor of ours may not be one of
    // their old units (data would be moved into a unit that stops existing). Two reorganisations into the same successor do not collide.
    const open = await tx.query<{ id: string; mapping_json: StoredProposal }>(`select id, mapping_json from machvon.unit_reorganization where status in ${OPEN_STATUSES}`);
    // The successor a saga created is a successor of it too, from the step that created it until the saga is over.
    const created = await tx.query<{ reorganization_id: string; unit_id: string }>(
      `select s.reorganization_id, s.detail->>'unit_id' as unit_id from machvon.unit_reorganization_step s join machvon.unit_reorganization r on r.tenant_id = s.tenant_id and r.id = s.reorganization_id
        where r.status in ${OPEN_STATUSES} and s.step_key like 'create-successor:%'`,
    );
    const busy = new Set<string>();
    for (const other of open) {
      const theirOld = other.mapping_json.predecessor_unit_ids;
      const theirNew = [...other.mapping_json.successors.flatMap((successor) => (successor.existing_unit_id === undefined ? [] : [successor.existing_unit_id])), ...created.filter((row) => row.reorganization_id === other.id).map((row) => row.unit_id)];
      // The unit a new successor goes under has to stand until the successor is created: it is a dependency of that reorganisation, in both directions.
      const theirParents = other.mapping_json.successors.flatMap((successor) => (successor.new_unit === undefined ? [] : [successor.new_unit.parentId]));
      for (const id of predecessorIds) if (theirParents.includes(id)) busy.add(id);
      for (const id of newParentIds) if (theirOld.includes(id)) busy.add(id);
      for (const id of predecessorIds) if (theirOld.includes(id) || theirNew.includes(id)) busy.add(id);
      for (const id of successorIds) if (theirOld.includes(id)) busy.add(id);
    }
    return { units, successors, membershipIds: members.map((row) => row.id), projectIds: projects.map((row) => row.id), strandedChildIds: stranded.map((row) => row.id), busyUnitIds: [...busy].sort() };
  }

  /**
   * The people who would hold two live memberships in the same unit once the members move: the table allows one membership of a person in a unit while it is Invited, Active or Suspended. Every live membership of an old unit
   * moves. A successor that does not exist yet is `new`.
   */
  async membershipCollisions(tx: TenantTx, input: ReorganizationInput, successorIds: readonly string[]): Promise<string[]> {
    const units = [...input.predecessorIds, ...successorIds.filter((id) => id !== 'new')];
    const rows = await tx.query<{ id: string; user_id: string; organization_id: string; status: string }>(
      "select id, user_id, organization_id, status from machvon.membership where organization_id = any($1::uuid[]) and status in ('Invited', 'Active', 'Suspended') order by id",
      [units],
    );
    const held = new Map<string, number>();
    const add = (user: string, unit: string): void => void held.set(`${user}|${unit}`, (held.get(`${user}|${unit}`) ?? 0) + 1);
    for (const row of rows) {
      const moves = input.predecessorIds.includes(row.organization_id);
      if (!moves) {
        add(row.user_id, row.organization_id);
        continue;
      }
      const target = reorganizationSuccessorOf(input, 'membership', row.id, successorIds);
      // A member with no successor is the mapping's to report; here it stays where it is.
      add(row.user_id, target ?? row.organization_id);
    }
    return [...new Set([...held].filter(([, count]) => count > 1).map(([key]) => key.split('|')[0] as string))].sort();
  }

  /** The units by id, with their names as they are now (the old units keep theirs). */
  async unitsOf(tx: TenantTx, ids: readonly string[]): Promise<UnitFact[]> {
    const rows = await tx.query<{ id: string; code: string; name: string; status: string; valid_from: string; valid_until: string | null }>('select id, code, name, status, valid_from::text as valid_from, valid_until::text as valid_until from machvon.organization_unit where id = any($1::uuid[]) order by id', [ids]);
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status, validFrom: row.valid_from, validUntil: row.valid_until }));
  }

  async insert(tx: TenantTx, input: { kind: ReorganizationKind; effectiveFrom: string; legalBasisRef: string; proposal: StoredProposal; requestedBy: string }): Promise<ReorganizationRecord> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.unit_reorganization (tenant_id, id, kind, effective_from, legal_basis_ref, mapping_json, status, requested_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::date, $3, $4::jsonb, 'PendingApproval', $5::uuid) returning id`,
      [input.kind, input.effectiveFrom, input.legalBasisRef, JSON.stringify(input.proposal), input.requestedBy],
    );
    return (await this.find(tx, (row as { id: string }).id)) as ReorganizationRecord;
  }

  async find(tx: TenantTx, id: string): Promise<ReorganizationRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async list(tx: TenantTx, filters: { status?: string | undefined; id?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<ReorganizationRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or r.status = $1) and ($2::uuid is null or r.id = $2::uuid) and ($3::timestamptz is null or (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        order by r.created_at desc, r.id desc limit $5::int`,
      [filters.status ?? null, filters.id ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  /** The steps already done, in the order they were done, for the timeline. */
  async steps(tx: TenantTx, id: string): Promise<Array<{ key: string; doneAt: string; detail: Record<string, unknown> }>> {
    const rows = await tx.query<{ step_key: string; done_at: string; detail: Record<string, unknown> }>(`select step_key, ${TIME('done_at')} as done_at, detail from machvon.unit_reorganization_step where reorganization_id = $1::uuid order by done_at, step_key`, [id]);
    return rows.map((row) => ({ key: row.step_key, doneAt: row.done_at, detail: row.detail }));
  }

  // ---- the decision --------------------------------------------------------------------------------------------------------------

  /**
   * \`decideUnitReorganization\`: by someone other than the proposer (403 \`SELF_APPROVAL_DENIED\`), at the version that was read. Approving a proposal that waits, or one whose saga failed, puts it in Applying (the job carries it out);
   * returning sends a proposal that waits back to Draft, rejecting cancels it. 409 \`REORG_STATE_INVALID\` for any other state.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: { decision: 'approve' | 'return' | 'reject'; by: string; reason: string; evidenceIds: readonly string[]; now: Date }): Promise<{ before: ReorganizationRecord; after: ReorganizationRecord }> {
    const [locked] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid for update of r`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = toRecord(locked);
    // The proposer does not approve or send back their own proposal; they may withdraw it (reject), as may whoever may decide.
    if (before.requestedBy === input.by && input.decision !== 'reject') throw new DomainError('SELF_APPROVAL_DENIED', 403);
    // A saga that failed has moved some of the world already: it is carried on, never abandoned half way, so it can only be approved again.
    const allowed = input.decision === 'approve' ? ['PendingApproval', 'Failed'] : input.decision === 'return' ? ['PendingApproval'] : ['PendingApproval', 'Draft'];
    if (!allowed.includes(before.status)) throw new DomainError('REORG_STATE_INVALID', 409, 'status');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const status = input.decision === 'approve' ? 'Applying' : input.decision === 'return' ? 'Draft' : 'Cancelled';
    await tx.query(
      `update machvon.unit_reorganization set status = $2, approved_by = case when $3 then $4::uuid else approved_by end, decided_at = $5::timestamptz, decision_reason = $6, decision_evidence_ids = $7::uuid[],
              result_summary = case when $2 = 'Applying' then null else result_summary end, version = version + 1 where id = $1::uuid`,
      [id, status, input.decision === 'approve', input.by, input.now.toISOString(), input.reason, [...input.evidenceIds]],
    );
    return { before, after: (await this.find(tx, id)) as ReorganizationRecord };
  }

  // ---- the saga ------------------------------------------------------------------------------------------------------------------

  /** The reorganisations being carried out whose day has come (Vietnam date), the oldest first. */
  async dueIds(tx: TenantTx, today: string, limit: number): Promise<string[]> {
    const rows = await tx.query<{ id: string }>("select id from machvon.unit_reorganization where status = 'Applying' and effective_from <= $1::date order by effective_from, created_at, id limit $2::int", [today, limit]);
    return rows.map((row) => row.id);
  }

  /** How many sagas are being carried out and how many have stopped, for the gauge. */
  async counts(tx: TenantTx): Promise<{ applying: number; failed: number }> {
    const [row] = await tx.query<{ applying: string; failed: string }>("select (count(*) filter (where status = 'Applying'))::text as applying, (count(*) filter (where status = 'Failed'))::text as failed from machvon.unit_reorganization");
    return { applying: Number(row?.applying ?? 0), failed: Number(row?.failed ?? 0) };
  }

  /** The saga stopped on a step that could not be done: the reorganisation is Failed, with the step and the code, and goes on from there when it is decided again. */
  async fail(tx: TenantTx, id: string, failure: { step: string; code: string }, now: Date): Promise<void> {
    const [done] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.unit_reorganization_step where reorganization_id = $1::uuid', [id]);
    await tx.query("update machvon.unit_reorganization set status = 'Failed', result_summary = $2::jsonb, version = version + 1 where id = $1::uuid and status = 'Applying'", [
      id,
      JSON.stringify({ failed: { step: failure.step, code: failure.code, at: now.toISOString() }, steps_done: Number(done?.n ?? 0) }),
    ]);
  }

  private async record(tx: TenantTx, reorganizationId: string, key: string, detail: Record<string, unknown> = {}): Promise<void> {
    await tx.query('insert into machvon.unit_reorganization_step (tenant_id, reorganization_id, step_key, detail) values (nullif(current_setting(\'app.tenant_id\', true), \'\')::uuid, $1::uuid, $2, $3::jsonb) on conflict do nothing', [reorganizationId, key, JSON.stringify(detail)]);
  }

  private async done(tx: TenantTx, reorganizationId: string, key: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await tx.query<{ detail: Record<string, unknown> }>('select detail from machvon.unit_reorganization_step where reorganization_id = $1::uuid and step_key = $2', [reorganizationId, key]);
    return row?.detail;
  }

  /**
   * The next step of the saga, in one transaction: the successor that is new is created; the successions are written; each active member of an old unit moves to its successor; each active grant over an old unit is made again over
   * the successor and the old one Expires; each open project goes to its successor through the port; the old units become Superseded (merge, split, rename) or Dissolved; and the last step announces it and the reorganisation is Applied.
   * A reorganisation whose day has not come waits. A member or project with no successor stops the saga (422 \`REORG_MAPPING_INCOMPLETE\`).
   */
  async step(tx: TenantTx, effects: ApprovalEffects, id: string, today: string, now: Date, port: ReorganizationProjectPort): Promise<StepOutcome> {
    let at = `reorg:${id}:prepare`;
    try {
      return await this.stepInner(tx, effects, id, today, now, port, (key) => void (at = key));
    } catch (error) {
      // The job says which step stopped the saga: the step is named on the error that stopped it.
      if (typeof error === 'object' && error !== null) (error as { reorganizationStep?: string }).reorganizationStep = at;
      throw error;
    }
  }

  private async stepInner(tx: TenantTx, effects: ApprovalEffects, id: string, today: string, now: Date, port: ReorganizationProjectPort, mark: (key: string) => void): Promise<StepOutcome> {
    // The unit tree is locked before any row, in the order of every command that changes the tree (a step that waits for a row while holding the lock of a command that waits for the tree would be a deadlock).
    await lockUnitTree(tx);
    const [locked] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid for update of r`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const reorganization = toRecord(locked);
    if (reorganization.status !== 'Applying') throw new DomainError('REORG_STATE_INVALID', 409, 'status');
    if (reorganization.effectiveFrom > today) return { kind: 'WAITING' };
    const input = inputOf(reorganization);
    const predecessors = reorganization.proposal.predecessor_unit_ids;
    const key = (step: string, item?: string): string => (item === undefined ? step : `${step}:${item}`);
    const at = (step: string, item?: string): void => mark(`reorg:${id}:${key(step, item)}`);
    const finishStep = async (step: string, item: string | undefined, detail: Record<string, unknown>, audit: Record<string, unknown>): Promise<StepOutcome> => {
      await this.record(tx, id, key(step, item), detail);
      await effects.audit({ action: 'org_unit.reorganization_step', resourceType: 'unit_reorganization', resourceId: id, diff: { step: key(step, item), ...audit } });
      return { kind: 'STEP', key: `reorg:${id}:${key(step, item)}` };
    };

    // 1. the successor that is new
    const created = reorganization.proposal.successors.find((successor) => successor.new_unit !== undefined)?.new_unit;
    let createdId: string | undefined;
    if (created !== undefined) {
      const detail = await this.done(tx, id, key('create-successor', id));
      createdId = detail?.unit_id as string | undefined;
      if (createdId === undefined) {
        at('create-successor', id);
        await lockUnitTree(tx);
        const unit = await createUnit(tx, { ...created, validFrom: reorganization.effectiveFrom });
        return finishStep('create-successor', id, { unit_id: unit.id }, { unit_id: unit.id });
      }
    }
    const successorIds = reorganization.proposal.successors.map((successor) => successor.existing_unit_id ?? (createdId as string));
    // The successors are looked at again on the day: one that stopped existing meanwhile (another reorganisation took it over) does not receive anything.
    const gone = await tx.query<{ id: string }>("select id from machvon.organization_unit where id = any($1::uuid[]) and (status in ('Superseded', 'Dissolved') or (valid_until is not null and valid_until <= $2::date)) limit 1", [successorIds, today]);
    if (gone[0] !== undefined) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'successors', { extensions: { unit_id: gone[0].id } });

    // 2. the successors that were planned stand from today
    const planned = await tx.query<{ id: string }>("select id from machvon.organization_unit where id = any($1::uuid[]) and status = 'Planned' order by id limit 1 for update", [successorIds]);
    if (planned[0] !== undefined) {
      at('activate-successor', planned[0].id);
      await tx.query("update machvon.organization_unit set status = 'Active', version = version + 1 where id = $1::uuid", [planned[0].id]);
      return finishStep('activate-successor', planned[0].id, { unit_id: planned[0].id }, { unit_id: planned[0].id });
    }

    // 3. who succeeds whom
    for (const predecessor of predecessors) {
      if ((await this.done(tx, id, key('succession', predecessor))) === undefined) {
        at('succession', predecessor);
        for (const successor of successorIds) {
          await tx.query(
            `insert into machvon.organization_unit_succession (tenant_id, id, reorganization_id, predecessor_unit_id, successor_unit_id, effective_from, mapping_note)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::date, $5) on conflict (tenant_id, predecessor_unit_id, successor_unit_id) do nothing`,
            [id, predecessor, successor, reorganization.effectiveFrom, reorganization.kind],
          );
        }
        return finishStep('succession', predecessor, { successors: successorIds }, { predecessor_unit_id: predecessor, successor_unit_ids: successorIds });
      }
    }

    // 4. the members
    const [member] = await tx.query<{ id: string }>("select id from machvon.membership where organization_id = any($1::uuid[]) and status in ('Invited', 'Active', 'Suspended') order by id limit 1 for update", [predecessors]);
    if (member !== undefined) {
      at('membership', member.id);
      const target = reorganizationSuccessorOf(input, 'membership', member.id, successorIds);
      if (target === undefined) throw new DomainError('REORG_MAPPING_INCOMPLETE', 422, 'membership', { extensions: { membership_id: member.id } });
      // The membership's version moves with its unit, so a suspend or end command prepared on the directory as it was is refused as stale.
      await tx.query('update machvon.membership set organization_id = $2::uuid, version = version + 1 where id = $1::uuid', [member.id, target]);
      await bumpScopeVersion(tx, [member.id]);
      return finishStep('membership', member.id, { to_unit_id: target }, { membership_id: member.id, to_unit_id: target });
    }

    // 5. the grants over the old units
    // A grant whose window is over (still marked Active until something marks it) is not made again.
    type GrantRow = { id: string; membership_id: string; role_id: string; scope_kind: string; scope_ref_ids: string[]; effective_from: string; effective_until: string | null };
    const grantSql = (byId: boolean): string =>
      `select id, membership_id, role_id, scope_kind, scope_ref_ids, ${TIME('effective_from')} as effective_from, ${TIME('effective_until')} as effective_until from machvon.role_grant
        where status = 'Active' and scope_kind in ('UNIT_SUBTREE', 'UNIT_ONLY') and scope_ref_ids && $1::uuid[] and (effective_until is null or effective_until > $2::timestamptz)${byId ? ' and id = $3::uuid' : ''} order by id limit 1${byId ? ' for update' : ''}`;
    const [candidate] = await tx.query<GrantRow>(grantSql(false), [predecessors, now.toISOString()]);
    let grant: GrantRow | undefined;
    if (candidate !== undefined) {
      // The order of the other writers (revoking a grant): the membership first, then the grant, looked at again once both are held.
      await tx.query('select id from machvon.membership where id = $1::uuid for update', [candidate.membership_id]);
      [grant] = await tx.query<GrantRow>(grantSql(true), [predecessors, now.toISOString(), candidate.id]);
      // Revoked or ended meanwhile: nothing to carry over, and the next pass looks again.
      if (grant === undefined) return { kind: 'STEP', key: `reorg:${id}:grant-gone:${candidate.id}` };
    }
    if (grant !== undefined) {
      at('grant', grant.id);
      const defaultSuccessor = reorganization.proposal.mapping.default_successor_unit_id;
      const replacement = successorIds.length === 1 ? [successorIds[0] as string] : defaultSuccessor === undefined ? successorIds : [defaultSuccessor];
      const refs = [...new Set([...grant.scope_ref_ids.filter((ref) => !predecessors.includes(ref)), ...replacement])].sort();
      const paths = (await tx.query<{ path: string }>('select path from machvon.organization_unit where id = any($1::uuid[]) order by id', [refs])).map((row) => row.path);
      const scopeJson = JSON.stringify({ kind: grant.scope_kind, ref_ids: refs, path_prefixes: paths });
      // The new grant has the window of the old one: it starts when the old one starts (never before today) and ends when it ends, so a limited grant stays limited. The table allows one active grant of a role over a scope
      // whatever its dates: a holder who already has it over the successor keeps that grant, whose window is widened to take in the old one when the two overlap or touch (two grants that meet on one scope become one); if the
      // windows are apart the old grant is not carried over (access is never given for the time between), and the step says so.
      const from = new Date(Math.max(now.getTime(), Date.parse(grant.effective_from)));
      const until = grant.effective_until === null ? null : new Date(grant.effective_until);
      const [held] = await tx.query<{ id: string; effective_from: string; effective_until: string | null }>(
        "select id, " + TIME('effective_from') + " as effective_from, " + TIME('effective_until') + " as effective_until from machvon.role_grant where membership_id = $1::uuid and role_id = $2::uuid and scope_kind = $3 and scope_ref_ids = $4::uuid[] and status = 'Active' and id <> $5::uuid for update",
        [grant.membership_id, grant.role_id, grant.scope_kind, refs, grant.id],
      );
      let carried: 'MADE' | 'WIDENED' | 'COVERED' | 'APART' = 'MADE';
      if (held === undefined) {
        await tx.query(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason, reorganization_id)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::jsonb, $4::timestamptz, $10::timestamptz, $5, $6::uuid[], 'Active', $7::uuid, $8, $9::uuid)`,
          [grant.membership_id, grant.role_id, scopeJson, from.toISOString(), grant.scope_kind, refs, reorganization.approvedBy ?? reorganization.requestedBy, `Tổ chức lại đơn vị: ${reorganization.legalBasisRef}`, id, grant.effective_until],
        );
      } else {
        const heldFrom = Date.parse(held.effective_from);
        const heldUntil = held.effective_until === null ? Number.POSITIVE_INFINITY : Date.parse(held.effective_until);
        const newUntil = until === null ? Number.POSITIVE_INFINITY : until.getTime();
        if (heldFrom <= from.getTime() && heldUntil >= newUntil) carried = 'COVERED';
        else if (from.getTime() > heldUntil || heldFrom > newUntil) carried = 'APART';
        else {
          carried = 'WIDENED';
          await tx.query('update machvon.role_grant set effective_from = $2::timestamptz, effective_until = $3::timestamptz, version = version + 1 where id = $1::uuid', [
            held.id,
            new Date(Math.min(heldFrom, from.getTime())).toISOString(),
            Math.max(heldUntil, newUntil) === Number.POSITIVE_INFINITY ? null : new Date(Math.max(heldUntil, newUntil)).toISOString(),
          ]);
        }
      }
      // The old grant ends when the new one starts (never before it began).
      await tx.query("update machvon.role_grant set status = 'Expired', effective_until = greatest($2::timestamptz, effective_from + interval '1 second'), version = version + 1 where id = $1::uuid", [grant.id, now.toISOString()]);
      await bumpScopeVersion(tx, [grant.membership_id]);
      return finishStep('grant', grant.id, { membership_id: grant.membership_id, scope_ref_ids: refs, carried }, { grant_id: grant.id, membership_id: grant.membership_id, carried });
    }

    // 6. the projects
    const doneProjects = (await tx.query<{ step_key: string }>("select step_key from machvon.unit_reorganization_step where reorganization_id = $1::uuid and step_key like 'project:%'", [id])).map((row) => row.step_key.slice('project:'.length));
    const [project] = await tx.query<{ id: string; owner_unit_id: string }>("select id, owner_unit_id from machvon.project where owner_unit_id = any($1::uuid[]) and status <> 'CLOSED' and not (id = any($2::uuid[])) order by id limit 1 for update", [predecessors, doneProjects]);
    if (project !== undefined) {
      at('project', project.id);
      const target = reorganizationSuccessorOf(input, 'project', project.id, successorIds);
      if (target === undefined) throw new DomainError('REORG_MAPPING_INCOMPLETE', 422, 'project', { extensions: { project_id: project.id } });
      await port.transfer(tx, { reorganizationId: id, projectId: project.id, fromUnitId: project.owner_unit_id, toUnitId: target, effectiveFrom: reorganization.effectiveFrom, idempotencyKey: `reorg:${id}:project:${project.id}` });
      return finishStep('project', project.id, { to_unit_id: target }, { project_id: project.id, to_unit_id: target });
    }

    // 7. the old units
    const [old] = await tx.query<{ id: string }>("select id from machvon.organization_unit where id = any($1::uuid[]) and status in ('Planned', 'Active') order by id limit 1 for update", [predecessors]);
    if (old !== undefined) {
      at('retire', old.id);
      // A person invited into the old unit after the members were moved would be left in a unit that stops existing: an invitation holds a shared lock of the unit row to its commit, so looked at again under the lock of the row, none is missed. The saga stops (Failed) and approving it again moves them.
      const late = await tx.query<{ id: string }>("select id from machvon.membership where organization_id = any($1::uuid[]) and status in ('Invited', 'Active', 'Suspended') limit 1", [predecessors]);
      if (late[0] !== undefined) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'predecessor_unit_ids', { extensions: { live_membership_ids: [late[0].id] } });
      // A unit that came under the old one while the proposal waited would be left under a unit that stops existing: looked at again, under the lock of the tree.
      const stranded = await tx.query<{ id: string }>("select id from machvon.organization_unit where parent_id = any($1::uuid[]) and not (id = any($1::uuid[])) and status in ('Planned', 'Active') limit 1", [predecessors]);
      if (stranded[0] !== undefined) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'predecessor_unit_ids', { extensions: { stranded_child_unit_ids: [stranded[0].id] } });
      const successor = reorganization.proposal.mapping.default_successor_unit_id ?? (successorIds.length === 1 ? (successorIds[0] as string) : null);
      await tx.query("update machvon.organization_unit set status = $2, valid_until = $3::date, successor_id = $4::uuid, version = version + 1 where id = $1::uuid", [old.id, reorganization.kind === 'DISSOLVE' ? 'Dissolved' : 'Superseded', reorganization.effectiveFrom, successor]);
      return finishStep('retire', old.id, { status: reorganization.kind === 'DISSOLVE' ? 'Dissolved' : 'Superseded' }, { unit_id: old.id });
    }

    // 8. done: announce it
    at('finish');
    const steps = await this.steps(tx, id);
    const count = (prefix: string): number => steps.filter((step) => step.key.startsWith(`${prefix}:`)).length;
    const touched = [...new Set(steps.flatMap((step) => (typeof step.detail.membership_id === 'string' ? [step.detail.membership_id] : step.key.startsWith('membership:') ? [step.key.slice('membership:'.length)] : [])))].sort();
    const summary = { steps_done: steps.length, memberships: count('membership'), grants: count('grant'), projects: count('project'), successor_unit_ids: successorIds };
    await tx.query("update machvon.unit_reorganization set status = 'Applied', applied_at = $2::timestamptz, result_summary = $3::jsonb, version = version + 1 where id = $1::uuid", [id, now.toISOString(), JSON.stringify(summary)]);
    await effects.audit({ action: 'org_unit.reorganization_applied', resourceType: 'unit_reorganization', resourceId: id, diff: { kind: reorganization.kind, ...summary } });
    await effects.emit({
      aggregateType: 'unit_reorganization',
      aggregateId: id,
      aggregateVersion: reorganization.version + 1,
      type: 'iam.org_unit.reorganization_applied.v1',
      schemaVersion: 1,
      payload: { reorganization_id: id, kind: reorganization.kind, effective_from: reorganization.effectiveFrom, predecessor_unit_ids: predecessors, ...summary },
      eventKey: `unit_reorganization:${id}:applied`,
    });
    if (touched.length > 0) {
      await effects.emit({
        aggregateType: 'unit_reorganization',
        aggregateId: id,
        aggregateVersion: reorganization.version + 1,
        type: 'iam.access.changed.v1',
        schemaVersion: 1,
        payload: { membership_ids: touched, cause: 'UNIT_REORGANIZATION', reorganization_id: id },
        eventKey: `access-changed:reorg:${id}`,
      });
    }
    return { kind: 'APPLIED' };
  }
}

/** The members and projects the proposal leaves without a successor, from the facts. */
export function missingOf(input: ReorganizationInput, facts: Pick<ReorganizationFacts, 'membershipIds' | 'projectIds'>, successorIds: readonly string[]): { memberships: string[]; projects: string[] } {
  return unmappedByReorganization(input, facts.membershipIds, facts.projectIds, successorIds);
}
