import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MAX_UNIT_DEPTH, TenantDatabase, UnitReorganizationStore, loadUnit, lockUnitTree, missingReorganizationMapping } from '@machvon/db';
import type { ReorganizationRecord, StoredReorganizationProposal, UnitFact } from '@machvon/db';
import { DomainError, assertValidReorganization, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ReorganizationInput, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { orgUnitCreateOf } from '../../org-unit-dto';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const PROPOSE = 'iam.unit.reorganize';
const APPROVE = 'iam.unit.reorganize.approve';
const READ = 'iam.unit.reorganize.read';
const STATUSES: readonly string[] = ['Draft', 'PendingApproval', 'Approved', 'Applying', 'Applied', 'Failed', 'Cancelled'];

/** A reorganisation moves members, grants and projects of whole units: it is the tenant's to propose, to approve and to read, not a unit's. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

const lower = (value: string): string => value.toLowerCase();

/**
 * The commands of the reorganisation of organisation units (ST-ADM-015, ADM 3.2). A proposal is checked against the units as they are now (they exist and are active, nothing is left under a unit that stops existing, no other
 * reorganisation holds them) and against the mapping: every active member and every project that is not closed of the old units must have a successor, or the proposal is refused (422 \`REORG_MAPPING_INCOMPLETE\`, listing them) and
 * nothing is stored. The approval puts it in Applying; the job \`unit-reorganization\` carries it out from its effective date, step by step.
 */
@Controller()
export class UnitReorganizationCommandsController {
  private readonly store = new UnitReorganizationStore();

  @Post('unit-reorganizations')
  @HttpCode(201)
  @OperationId('proposeUnitReorganization')
  @Command({ operation: 'proposeUnitReorganization' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['UnitReorganizationCreate']): Promise<CommandResult> {
    assertHolds(access, PROPOSE);
    const today = vietnamDateOf(new Date());
    const input: ReorganizationInput = {
      // A transfer is in the contract and not in the saga: the rules refuse it (it is the move of a unit).
      kind: body.kind as ReorganizationInput['kind'],
      effectiveFrom: body.effective_from,
      predecessorIds: body.predecessor_unit_ids.map(lower),
      successors: (body.successors ?? []).map((successor) => ({ existingUnitId: successor.existing_unit_id === undefined ? undefined : lower(successor.existing_unit_id), newUnit: successor.new_unit })),
      mapping: {
        memberships: (body.mapping.memberships ?? []).map((entry) => ({ membershipId: lower(entry.membership_id), successorUnitId: lower(entry.successor_unit_id) })),
        projects: (body.mapping.projects ?? []).map((entry) => ({ projectId: lower(entry.project_id), successorUnitId: lower(entry.successor_unit_id) })),
        defaultSuccessorUnitId: body.mapping.default_successor_unit_id === undefined ? undefined : lower(body.mapping.default_successor_unit_id),
      },
    };
    assertValidReorganization(input, today);

    // The tree is held while the proposal is judged and stored, so that two proposals on the same units are not both let in.
    await lockUnitTree(scope.tx);
    const existingSuccessors = input.successors.flatMap((successor) => (successor.existingUnitId === undefined ? [] : [successor.existingUnitId]));
    const newParents = (body.successors ?? []).flatMap((successor) => (successor.new_unit === undefined ? [] : [lower(successor.new_unit.parent_id)]));
    const facts = await this.store.facts(scope.tx, input.predecessorIds, existingSuccessors, newParents);
    // A unit of another tenant is not there for this one (404), as everywhere.
    if (facts.units.length !== input.predecessorIds.length || facts.successors.length !== existingSuccessors.length) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (facts.units.some((unit) => unit.status !== 'Active')) throw new DomainError('VALIDATION_FAILED', 422, 'predecessor_unit_ids');
    if (facts.successors.some((unit) => unit.status !== 'Active' && unit.status !== 'Planned')) throw new DomainError('VALIDATION_FAILED', 422, 'successors');
    // An old unit ends the day the reorganisation takes effect, so it has to have begun before; and a successor has to have begun by then.
    if (facts.units.some((unit) => input.effectiveFrom <= unit.validFrom)) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'effective_from');
    // ... and has not ended by then.
    if (facts.successors.some((unit) => unit.validFrom > input.effectiveFrom || (unit.validUntil !== null && unit.validUntil <= (input.effectiveFrom > today ? input.effectiveFrom : today)))) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'successors');
    if (facts.strandedChildIds.length > 0) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'predecessor_unit_ids', { extensions: { stranded_child_unit_ids: facts.strandedChildIds } });
    if (facts.busyUnitIds.length > 0) throw new DomainError('REORG_STATE_INVALID', 409, 'predecessor_unit_ids', { extensions: { unit_ids: facts.busyUnitIds } });
    const newUnits = (body.successors ?? []).flatMap((successor) => (successor.new_unit === undefined ? [] : [orgUnitCreateOf(successor.new_unit)]));
    // A new unit goes under a unit that goes on: not under one of the old units, which end on the day it begins.
    for (const unit of newUnits) {
      if (input.predecessorIds.includes(lower(unit.parentId))) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'successors');
      // ... that exists, stands on the day the new unit begins and has no end before it (a unit has no end here), and is not so deep that the new one would be too deep: what the saga would refuse when it is too late to mend.
      const [parent] = await this.store.unitsOf(scope.tx, [unit.parentId]);
      if (parent === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if ((parent.status !== 'Active' && parent.status !== 'Planned') || parent.validFrom > input.effectiveFrom || parent.validUntil !== null) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'successors');
      if ((await loadUnit(scope.tx, unit.parentId)).depth + 1 > MAX_UNIT_DEPTH) throw new DomainError('UNIT_VALIDITY_INVALID', 422, 'successors');
    }

    // A mapping names members and projects the old units hold, and no others.
    input.mapping.memberships.forEach((entry, index) => {
      if (!facts.membershipIds.includes(entry.membershipId)) throw new DomainError('VALIDATION_FAILED', 422, `mapping.memberships[${index}]`);
    });
    input.mapping.projects.forEach((entry, index) => {
      if (!facts.projectIds.includes(entry.projectId)) throw new DomainError('VALIDATION_FAILED', 422, `mapping.projects[${index}]`);
    });
    // A person holds one membership in a unit: members who would meet in the same unit are refused.
    const collisions = await this.store.membershipCollisions(scope.tx, input, input.successors.length === 1 && existingSuccessors.length === 0 ? ['new'] : existingSuccessors);
    if (collisions.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'mapping.memberships', { extensions: { duplicate_user_ids: collisions } });
    // Nothing is left behind: the one successor takes everything, otherwise each member and project needs a place.
    const missing = missingReorganizationMapping(input, facts, input.successors.length === 1 ? ['sole'] : existingSuccessors);
    if (missing.memberships.length > 0 || missing.projects.length > 0) {
      throw new DomainError('REORG_MAPPING_INCOMPLETE', 422, missing.projects[0] ?? missing.memberships[0], {
        extensions: {
          missing_membership_ids: missing.memberships,
          missing_project_ids: missing.projects,
          errors: [...missing.memberships.map((id) => ({ field: 'mapping.memberships', id })), ...missing.projects.map((id) => ({ field: 'mapping.projects', id }))],
        },
      });
    }

    const proposal: StoredReorganizationProposal = {
      predecessor_unit_ids: input.predecessorIds as string[],
      successors: input.successors.map((successor, index) => {
        const created = (body.successors ?? [])[index]?.new_unit === undefined ? undefined : newUnits.shift();
        return created === undefined ? { existing_unit_id: successor.existingUnitId as string } : { new_unit: created };
      }),
      mapping: {
        memberships: input.mapping.memberships.map((entry) => ({ membership_id: entry.membershipId, successor_unit_id: entry.successorUnitId })),
        projects: input.mapping.projects.map((entry) => ({ project_id: entry.projectId, successor_unit_id: entry.successorUnitId })),
        ...(input.mapping.defaultSuccessorUnitId === undefined ? {} : { default_successor_unit_id: input.mapping.defaultSuccessorUnitId }),
      },
    };
    const created = await this.store.insert(scope.tx, { kind: input.kind, effectiveFrom: input.effectiveFrom, legalBasisRef: body.legal_basis_ref, proposal, requestedBy: scope.tenant.membershipId });
    await scope.audit({
      action: 'org_unit.reorganization_proposed',
      resourceType: 'unit_reorganization',
      resourceId: created.id,
      reason: body.legal_basis_ref,
      diff: { kind: input.kind, effective_from: input.effectiveFrom, predecessor_unit_ids: input.predecessorIds, successors: input.successors.length, memberships: facts.membershipIds.length, projects: facts.projectIds.length },
    });
    return commandResult(scope, 'PENDING_APPROVAL', created.version, created.id);
  }

  @Post('unit-reorganizations/:reorgId/decision')
  @HttpCode(202)
  @OperationId('decideUnitReorganization')
  @Command({ operation: 'decideUnitReorganization', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('reorgId', ParseUUIDPipe) reorgId: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    assertHolds(access, APPROVE);
    const { after } = await this.store.decide(scope.tx, lower(reorgId), scope.expectedVersion ?? 0, {
      decision: body.decision,
      by: scope.tenant.membershipId,
      reason: body.reason,
      evidenceIds: (body.evidence_ids ?? []).map(lower),
      now: new Date(),
    });
    await scope.audit({ action: 'org_unit.reorganization_decided', resourceType: 'unit_reorganization', resourceId: after.id, reason: body.reason, diff: { decision: body.decision, status: after.status, evidence_ids: body.evidence_ids ?? [] } });
    if (body.decision === 'approve') {
      await scope.emit({
        aggregateType: 'unit_reorganization',
        aggregateId: after.id,
        aggregateVersion: after.version,
        type: 'iam.org_unit.reorganization_approved.v1',
        schemaVersion: 1,
        payload: { reorganization_id: after.id, kind: after.kind, effective_from: after.effectiveFrom, predecessor_unit_ids: after.proposal.predecessor_unit_ids, approved_by: scope.tenant.membershipId },
        eventKey: `unit_reorganization:${after.id}:approved:${after.version}`,
      });
    }
    return commandResult(scope, after.status.toUpperCase(), after.version, after.id);
  }
}

function pageOf(rows: ReorganizationRecord[], limit: number, view: (row: ReorganizationRecord) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(view), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The proposals and the progress of the saga (ADM-16): the units by the names they have now, the mapping as counts, and for one proposal the steps done. */
@Controller('resources/unit_reorganization')
export class UnitReorganizationReadsController {
  private readonly store = new UnitReorganizationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private view(row: ReorganizationRecord, units: ReadonlyMap<string, UnitFact>, membershipId: string, mayApprove: boolean, created: string | undefined): Record<string, unknown> {
    const unit = (id: string): Record<string, unknown> => ({ id, code: units.get(id)?.code ?? null, name: units.get(id)?.name ?? null, status: units.get(id)?.status ?? null });
    const { proposal } = row;
    return {
      id: row.id,
      kind: row.kind,
      effective_from: row.effectiveFrom,
      legal_basis_ref: row.legalBasisRef,
      status: row.status,
      predecessors: proposal.predecessor_unit_ids.map(unit),
      successors: [...proposal.successors.flatMap((successor) => (successor.existing_unit_id === undefined ? [] : [unit(successor.existing_unit_id)])), ...(created === undefined ? [] : [unit(created)])],
      new_unit: proposal.successors.find((successor) => successor.new_unit !== undefined)?.new_unit === undefined ? null : { code: proposal.successors.find((successor) => successor.new_unit !== undefined)?.new_unit?.code, name: proposal.successors.find((successor) => successor.new_unit !== undefined)?.new_unit?.name },
      mapping: { memberships: proposal.mapping.memberships.length, projects: proposal.mapping.projects.length, default_successor_unit_id: proposal.mapping.default_successor_unit_id ?? null },
      requested_by: { id: row.requestedBy, name: row.requestedByName },
      approved_by: { id: row.approvedBy, name: row.approvedByName },
      decided_at: row.decidedAt,
      decision_reason: row.decisionReason,
      applied_at: row.appliedAt,
      result_summary: row.resultSummary,
      created_at: row.createdAt,
      version: row.version,
      // The server judges again: this only says whether the screen should offer it.
      // A proposal that waits or was sent back can be withdrawn by whoever may decide, its proposer included; approving, sending back or approving again a saga that failed is for someone else.
      actions: { decide: mayApprove && (row.status === 'Draft' || (row.requestedBy !== membershipId && (row.status === 'PendingApproval' || row.status === 'Failed')) || (row.requestedBy === membershipId && row.status === 'PendingApproval')) },
    };
  }

  @Get()
  @OperationId('get_resources_unit_reorganization')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    assertHolds(access, READ);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const mayApprove = holdsOnWholeTenant(access, APPROVE);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.store.list(tx, { status: status as string | undefined }, { limit: request.limit + 1, after: request.after });
      const ids = [...new Set(rows.flatMap((row) => [...row.proposal.predecessor_unit_ids, ...row.proposal.successors.flatMap((successor) => (successor.existing_unit_id === undefined ? [] : [successor.existing_unit_id]))]))];
      const units = new Map((await this.store.unitsOf(tx, ids)).map((unit) => [unit.id, unit]));
      return pageOf(rows, request.limit, (row) => this.view(row, units, tenant.membershipId, mayApprove, undefined));
    });
  }

  @Get(':id')
  @OperationId('get_resources_unit_reorganization_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertHolds(access, READ);
    const mayApprove = holdsOnWholeTenant(access, APPROVE);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const [row] = await this.store.list(tx, { id: lower(id) }, { limit: 1, after: undefined });
      if (row === undefined) return undefined;
      const steps = await this.store.steps(tx, row.id);
      const created = steps.find((step) => step.key === `create-successor:${row.id}`)?.detail.unit_id;
      const createdId = typeof created === 'string' ? created : undefined;
      const ids = [...row.proposal.predecessor_unit_ids, ...row.proposal.successors.flatMap((successor) => (successor.existing_unit_id === undefined ? [] : [successor.existing_unit_id])), ...(createdId === undefined ? [] : [createdId])];
      const units = new Map((await this.store.unitsOf(tx, ids)).map((unit) => [unit.id, unit]));
      return { ...this.view(row, units, tenant.membershipId, mayApprove, createdId), steps: steps.map((step) => ({ key: step.key, done_at: step.doneAt })) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...found, as_of: new Date().toISOString() };
  }
}
