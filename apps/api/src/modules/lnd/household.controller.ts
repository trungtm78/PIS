import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, HOUSEHOLD_STATUSES, LndHouseholdStore, TenantDatabase, householdScopeUnits, unitInScope } from '@machvon/db';
import type { HouseholdIdentity, HouseholdLine } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, vietnamDateOf, hasControlChar } from '@machvon/kernel';
import type { EffectiveAccess, FieldCipher, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FIELD_CIPHER, LND_METRICS } from './tokens';

const WRITE_PERMISSION = PERMISSIONS.registerAffectedHousehold;
const READ_PERMISSION = PERMISSIONS.listAffectedHouseholds;
const PII_PERMISSION = PERMISSIONS.revealHouseholdIdentity;
const DSR_PERMISSION = PERMISSIONS.handleHouseholdDataRequest;
const RESOURCE_TYPE = 'affected_household';
const LINK_TYPE = 'household_parcel';
const CLASSIFICATION = 'PERSONAL';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** A household as the screen reads it: an allowlist of what a household is. The personal data is in its masked forms only; the sealed data is read by `revealHouseholdIdentity`. */
export function householdLineView(line: HouseholdLine): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    owner_unit_id: line.ownerUnitId,
    household_code: line.householdCode,
    head_name_masked: line.headNameMasked,
    national_id_masked: line.nationalIdMasked,
    phone_masked: line.phoneMasked,
    address_masked: line.addressMasked,
    member_count: line.memberCount,
    policy_beneficiary: line.policyBeneficiary,
    legal_basis: line.legalBasis,
    legal_basis_ref: line.legalBasisRef,
    consent_record_id: line.consentRecordId,
    retention_until: line.retentionUntil,
    dsr_open: line.dsrOpen,
    processing_restricted: line.processingRestricted,
    anonymised: line.anonymised,
    status: line.status,
    parcels: line.parcels.map((parcel) => ({ id: parcel.id, parcel_id: parcel.parcelId, parcel_code: parcel.parcelCode, right_kind: parcel.rightKind, share_pct: parcel.sharePct })),
    created_at: line.createdAt,
    version: line.version,
  };
}

const REASON_MIN = 10;
const REASON_MAX = 300;

/** The reason a person gives for opening personal data: words of at least ten characters and at most three hundred, nothing that is not text. It is kept in the trail, so it is judged before anything is read. */
function reasonOf(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX || hasControlChar(reason)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason;
}

/** Which of the sealed fields a reading opened: their names, never their values. */
function openedFields(identity: HouseholdIdentity): string[] {
  const fields = ['head_name'];
  if (identity.nationalId !== null) fields.push('national_id');
  if (identity.phone !== null) fields.push('phone');
  if (identity.addressText !== null) fields.push('address_text');
  return fields;
}

const DSR_TYPE = 'household_data_request';

/**
 * The households affected by a land recovery (ST-LND-002, LND 3.5, BR-LND-07, BR-LND-09, UAT-AC379, UAT-AC380). A household is registered once, on a legal basis for processing its personal data and for as long as
 * the data is kept; the name, the identity number, the telephone and the address are sealed and only their masked forms are shown. A household belongs to the unit that answers for it and is seen from inside that
 * unit alone: the grants on a project or a contract reach no household. The trail and the events carry ids and codes, never a personal value.
 */
@Controller()
export class AffectedHouseholdController {
  private readonly households: LndHouseholdStore;

  constructor(@Inject(FIELD_CIPHER) cipher: FieldCipher) {
    this.households = new LndHouseholdStore(cipher);
  }

  @Post('affected-households')
  @HttpCode(200)
  @OperationId('registerAffectedHousehold')
  @Command({ operation: 'registerAffectedHousehold' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndRegisterAffectedHousehold']): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const created = await this.households.register(
      scope.tx,
      {
        projectId: body.project_id,
        ownerUnitId: body.owner_unit_id,
        headName: body.head_name,
        nationalId: body.national_id,
        phone: body.phone,
        addressText: body.address_text,
        memberCount: body.member_count,
        policyBeneficiary: body.policy_beneficiary,
        legalBasis: body.legal_basis,
        legalBasisRef: body.legal_basis_ref,
        consentRecordId: body.consent_record_id,
        retentionUntil: body.retention_until,
      },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.household_registered',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        household_code: created.householdCode,
        project_id: created.projectId,
        owner_unit_id: created.ownerUnitId,
        legal_basis: created.legalBasis,
        legal_basis_ref: created.legalBasisRef,
        retention_until: created.retentionUntil,
        sealed_fields: created.sealed,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'lnd.household.registered.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        household_id: created.id,
        project_id: created.projectId,
        owner_unit_id: created.ownerUnitId,
        household_code: created.householdCode,
        legal_basis: created.legalBasis,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  /**
   * The request of a person whose data a household holds (ST-LND-003, UAT-AC381): access, rectification, withdrawal of the consent, restriction or erasure. The data protection officer says who asked (verified),
   * what the outcome is and why. An erasure of a household that was paid is held back by the vouchers that must be kept (409 `RETENTION_LEGAL_HOLD`). The trail and the event carry the kind, the outcome and
   * the names of the fields that were erased, never a value and never the reason, which is kept with the request.
   */
  @Post('affected-households/:id/data-requests')
  @HttpCode(200)
  @OperationId('handleHouseholdDataRequest')
  @Command({ operation: 'handleHouseholdDataRequest' })
  async handleRequest(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndHandleHouseholdDataRequest'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, DSR_PERMISSION, now);
    const done = await this.households.handleRequest(
      scope.tx,
      id,
      { requestKind: body.request_kind, requesterVerified: body.requester_verified, outcome: body.outcome, reason: body.reason },
      scope.tenant.membershipId,
      units,
    );
    await scope.audit({
      action: 'lnd.household_data_request_handled',
      resourceType: RESOURCE_TYPE,
      resourceId: done.householdId,
      classification: CLASSIFICATION,
      diff: {
        request_id: done.id,
        project_id: done.projectId,
        owner_unit_id: done.ownerUnitId,
        request_kind: done.requestKind,
        outcome: done.outcome,
        requester_verified: true,
        erased_fields: done.erasedFields,
        retained_payments: done.retainedPayments,
        restricted: done.restricted,
        anonymised: done.anonymised,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.householdId,
      aggregateVersion: done.version,
      type: 'lnd.household.dsr_handled.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        household_id: done.householdId,
        request_id: done.id,
        project_id: done.projectId,
        owner_unit_id: done.ownerUnitId,
        request_kind: done.requestKind,
        outcome: done.outcome,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${DSR_TYPE}:${done.id}`,
    });
    return commandResult(scope, done.outcome, done.version, done.householdId);
  }

  @Post('affected-households/:id/parcels')
  @HttpCode(200)
  @OperationId('linkHouseholdParcel')
  @Command({ operation: 'linkHouseholdParcel' })
  async link(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndLinkHouseholdParcel'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const linked = await this.households.link(
      scope.tx,
      id,
      { parcelId: body.parcel_id, rightKind: body.right_kind, sharePct: body.share_pct, titleDocumentVersionId: body.title_document_version_id },
      scope.tenant.membershipId,
      units,
    );
    await scope.audit({
      action: 'lnd.household_parcel_linked',
      resourceType: LINK_TYPE,
      resourceId: linked.id,
      classification: CLASSIFICATION,
      diff: {
        household_id: linked.householdId,
        parcel_id: linked.parcelId,
        project_id: linked.projectId,
        owner_unit_id: linked.ownerUnitId,
        right_kind: linked.rightKind,
        share_pct: linked.sharePct,
        title_document_version_id: linked.titleDocumentVersionId,
      },
    });
    await scope.emit({
      aggregateType: LINK_TYPE,
      aggregateId: linked.id,
      aggregateVersion: 1,
      type: 'lnd.household.parcel_linked.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        household_id: linked.householdId,
        parcel_id: linked.parcelId,
        project_id: linked.projectId,
        owner_unit_id: linked.ownerUnitId,
        right_kind: linked.rightKind,
        share_pct: linked.sharePct,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${LINK_TYPE}:${linked.id}:1`,
    });
    return commandResult(scope, 'LINKED', 1, linked.id);
  }
}

/** The households of the unit of the caller (LND-03) and the one reading of their sealed data. */
@Controller()
export class AffectedHouseholdReadsController {
  private readonly households: LndHouseholdStore;
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FIELD_CIPHER) cipher: FieldCipher,
    @Optional() @Inject(LND_METRICS) metrics?: MetricsSink,
  ) {
    this.households = new LndHouseholdStore(cipher);
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Get('affected-households')
  @OperationId('listAffectedHouseholds')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = idOf(project, 'project_id');
    if (status !== undefined && !(HOUSEHOLD_STATUSES as readonly unknown[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      const units = await householdScopeUnits(tx, access, READ_PERMISSION, now);
      const personalUnits = await householdScopeUnits(tx, access, PII_PERMISSION, now);
      return this.households.list(tx, units, { projectId, status: typeof status === 'string' ? status : undefined, limit: request.limit + 1, after: request.after }, personalUnits);
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(householdLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.householdCode, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  /**
   * The sealed data of one household in the clear, for the holder of `lnd.pii.read` over the unit of the household. It is a read that writes: the audit row (which fields were opened and why, never their values) is
   * written in the same transaction as the read, so a read that is not recorded is not answered. The answer is not stored anywhere; a command would have kept it in the idempotency record.
   */
  @Get('affected-households/:id/identity')
  @OperationId('revealHouseholdIdentity')
  async reveal(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reason') reasonText?: unknown,
  ): Promise<Record<string, unknown>> {
    const reason = reasonOf(reasonText);
    const now = new Date();
    const identity = await this.database.withTenant(tenant, async (tx) => {
      const seen = await householdScopeUnits(tx, access, READ_PERMISSION, now);
      const units = await householdScopeUnits(tx, access, PII_PERMISSION, now);
      // A household the caller may not see does not exist for them; one they may see and may not open is a refusal.
      const found = await this.households.reveal(tx, id, seen);
      if (!unitInScope(units, found.ownerUnitId)) throw new DomainError('SCOPE_DENIED', 403);
      await this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'lnd.household_identity_revealed',
        resourceType: RESOURCE_TYPE,
        resourceId: found.id,
        classification: CLASSIFICATION,
        correlationId: randomUUID(),
        requestId: randomUUID(),
        diff: {
          household_code: found.householdCode,
          project_id: found.projectId,
          owner_unit_id: found.ownerUnitId,
          fields: openedFields(found),
          reason,
        },
      });
      return found;
    });
    this.metrics.increment('lnd_pii_decrypt_total', { outcome: 'revealed' });
    return {
      id: identity.id,
      project_id: identity.projectId,
      owner_unit_id: identity.ownerUnitId,
      household_code: identity.householdCode,
      head_name: identity.headName,
      national_id: identity.nationalId,
      phone: identity.phone,
      address_text: identity.addressText,
    };
  }
}
