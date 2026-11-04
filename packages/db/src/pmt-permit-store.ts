import { randomUUID } from 'node:crypto';
import { DomainError, isIsoDate, shiftDays, versionConflict, hasControlChar } from '@machvon/kernel';
import { PmtDossierStore } from './pmt-dossier-store.ts';
import type { PermitStatus, Readiness } from './pmt-dossier-store.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

export const MILESTONE_STEPS = ['SUBMITTED', 'ACKNOWLEDGED', 'APPRAISAL_MEETING', 'SUPPLEMENT_REQUESTED', 'SUPPLEMENT_SUBMITTED', 'DECISION', 'HANDED_OVER'] as const;
export type MilestoneStep = (typeof MILESTONE_STEPS)[number];
export type DecisionOutcome = 'ISSUED' | 'REJECTED';

/** A type is "current" in a dossier while a permit of it is ISSUED or EXEMPTED; "open" while an application is on its way (BR-PMT-01). */
const CURRENT_STATUSES: readonly PermitStatus[] = ['ISSUED', 'EXEMPTED'];
const OPEN_STATUSES: readonly PermitStatus[] = ['PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED'];
const MAX_TEXT = 2000;
const MAX_PERMIT_NO = 100;
const CURRENT_CONSTRAINTS = ['permit_current_uq', 'permit_code_current_uq'] as const;
const OPEN_CONSTRAINTS = ['permit_code_open_uq'] as const;
const NUMBER_CONSTRAINTS = ['permit_type_no_uq', 'permit_code_no_uq'] as const;

/** What a milestone step means for the status of the permit (PMT 4): the statuses it may be recorded in and the one it moves the permit to. */
interface StepRule {
  from: readonly PermitStatus[];
  to: PermitStatus | null;
  /** The step is a fact that happened: it carries the day it happened on. */
  happened: boolean;
}

const STEP_RULES: Readonly<Record<MilestoneStep, StepRule>> = {
  SUBMITTED: { from: ['PLANNED'], to: 'SUBMITTED', happened: true },
  ACKNOWLEDGED: { from: ['SUBMITTED'], to: 'IN_APPRAISAL', happened: true },
  APPRAISAL_MEETING: { from: ['IN_APPRAISAL'], to: null, happened: false },
  SUPPLEMENT_REQUESTED: { from: ['IN_APPRAISAL'], to: 'SUPPLEMENT_REQUESTED', happened: true },
  SUPPLEMENT_SUBMITTED: { from: ['SUPPLEMENT_REQUESTED'], to: 'IN_APPRAISAL', happened: true },
  DECISION: { from: ['IN_APPRAISAL'], to: null, happened: false },
  HANDED_OVER: { from: ['ISSUED'], to: null, happened: true },
};

export interface NewPermit {
  permitTypeId: string;
  authorityName?: string | undefined;
  expectedDecisionOn?: string | undefined;
  responsibleMembershipId?: string | undefined;
}

export interface MilestoneInput {
  stepCode: string;
  plannedOn?: string | undefined;
  actualOn?: string | undefined;
  note?: string | undefined;
  documentVersionId?: string | undefined;
}

export interface DecisionInput {
  outcome: string;
  permitNo?: string | undefined;
  issuedOn?: string | undefined;
  validFrom?: string | undefined;
  validUntil?: string | undefined;
  noExpiry?: boolean | undefined;
  documentVersionId?: string | undefined;
  reason?: string | undefined;
}

export interface RenewalInput {
  newPermitNo: string;
  newValidUntil: string;
  documentVersionId: string;
}

export interface ExemptionInput {
  basis: string;
  decisionDocumentVersionId: string;
}

export interface RevocationInput {
  reason: string;
  decisionDocumentVersionId: string;
}

/** What a command did to a permit: the facts its audit row and its event carry, as stored. */
export interface PermitChange {
  id: string;
  dossierId: string;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeRevision: number;
  fromStatus: PermitStatus | null;
  status: PermitStatus;
  version: number;
  permitNo: string | null;
  validFrom: string | null;
  validUntil: string | null;
  noExpiry: boolean;
  readiness: Readiness | null;
}

export interface MilestoneChange extends PermitChange {
  milestoneId: string;
  stepCode: MilestoneStep;
  plannedOn: string | null;
  actualOn: string | null;
  note: string | null;
  documentVersionId: string | null;
  expectedDecisionOn: string | null;
}

export interface DecisionChange extends PermitChange {
  outcome: DecisionOutcome;
  issuedOn: string | null;
  documentVersionId: string | null;
}

export interface RenewalChange extends PermitChange {
  supersededId: string;
  supersededVersion: number;
  issuedOn: string;
  documentVersionId: string;
}

export interface ExemptionChange extends PermitChange {
  decisionDocumentVersionId: string;
  exemptedOn: string;
}

export interface RevocationChange extends PermitChange {
  reason: string;
  revocationDocumentVersionId: string;
}

interface TypeSql {
  id: string;
  code: string;
  revision: number;
  status: string;
  authority_text: string;
  default_validity_months: number | null;
  default_processing_days: number | null;
  effective_from: string;
  effective_until: string | null;
}

interface PermitSql {
  id: string;
  dossier_id: string;
  permit_type_id: string;
  type_code: string;
  type_revision: number;
  default_validity_months: number | null;
  default_processing_days: number | null;
  status: PermitStatus;
  version: string;
  permit_no: string | null;
  issued_on: string | null;
  valid_from: string | null;
  valid_until: string | null;
  no_expiry: boolean;
  is_required: boolean;
  authority_name: string | null;
  responsible_membership_id: string | null;
  submitted_on: string | null;
  expected_decision_on: string | null;
  document_version_id: string | null;
  exemption_allowed: boolean;
  created_by: string;
  updated_by: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (): DomainError => new DomainError('PERMIT_STATE_INVALID', 409);

/** A text as it is stored: trimmed, not empty, without control characters, within its length. */
function textOf(value: string, field: string, max: number): string {
  const text = value.trim();
  if (text === '' || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

function dateOf(value: string, field: string): string {
  if (!isIsoDate(value)) throw invalid(field);
  return value;
}

/**
 * The last day of a validity of `months` months that begins on `from` (BR-PMT-04): 12 months from 2026-01-01 end on 2026-12-31, and a
 * validity that begins on the 31st ends in a shorter month on its last day.
 */
export function validityEnd(from: string, months: number): string {
  const [year, month, day] = from.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInMonth));
  return shiftDays(target.toISOString().slice(0, 10), -1);
}

/**
 * The permits of a dossier (ST-PMT-002, PMT 3.1 and 4): a permit is added, moves along its milestones, is decided, renewed by a
 * replacement or revoked. A permit keeps the id of the permit type VERSION it was written under for good; what makes a permit "the
 * current one" is its TYPE (the stable code), so a revision of the regulation in the middle of a permit's life lets neither a second
 * current permit nor a repeated number in. The unique indexes and the guard trigger of the table have the last word; this store says why.
 */
export class PmtPermitStore {
  private readonly dossiers: PmtDossierStore;

  constructor(dossiers: PmtDossierStore = new PmtDossierStore()) {
    this.dossiers = dossiers;
  }

  /**
   * Adds a permit (an optional one: the required ones are planned when the dossier is opened) of a type version that applies today.
   * A type that already has a current permit in the dossier, or an application on its way, is 409 PERMIT_ALREADY_CURRENT: a second
   * permit of a type is a renewal of the first or the next attempt after a rejection.
   */
  async add(tx: TenantTx, dossierId: string, input: NewPermit, actor: string): Promise<PermitChange> {
    await this.lockDossier(tx, dossierId);
    const type = await this.typeOf(tx, input.permitTypeId.toLowerCase());
    if (type === undefined) throw invalid('permit_type_id');
    const asOf = this.dossiers.currentDate();
    if (!inForce(type, asOf)) throw new DomainError('PERMIT_TYPE_NOT_EFFECTIVE', 422);
    const authorityName = input.authorityName === undefined ? type.authority_text : textOf(input.authorityName, 'authority_name', MAX_TEXT);
    const expectedDecisionOn = input.expectedDecisionOn === undefined ? null : dateOf(input.expectedDecisionOn, 'expected_decision_on');
    const responsible = input.responsibleMembershipId?.toLowerCase() ?? null;
    if (responsible !== null) await this.dossiers.assertMember(tx, responsible, 'responsible_membership_id');
    const held = await tx.query<{ is_required: boolean; status: PermitStatus }>(
      'select is_required, status from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2',
      [dossierId, type.code],
    );
    if (held.some((permit) => CURRENT_STATUSES.includes(permit.status) || OPEN_STATUSES.includes(permit.status))) throw new DomainError('PERMIT_ALREADY_CURRENT', 409);
    // A type the dossier must hold a permit of stays required when the next attempt follows a rejection.
    const isRequired = held.some((permit) => permit.is_required);
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: [...CURRENT_CONSTRAINTS, ...OPEN_CONSTRAINTS], code: 'PERMIT_ALREADY_CURRENT' }, () =>
      tx.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, authority_name, expected_decision_on, responsible_membership_id, is_required, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::uuid, $7, $8::uuid, $8::uuid)`,
        [id, dossierId, type.id, authorityName, expectedDecisionOn, responsible, isRequired, actor],
      ),
    );
    return { ...blank(id, dossierId, type), fromStatus: null, status: 'PLANNED', version: 1, readiness: null };
  }

  /**
   * Records a milestone and moves the permit as the step says (PLANNED, SUBMITTED, IN_APPRAISAL and back from SUPPLEMENT_REQUESTED).
   * A step that happened carries the day it happened on, never a day to come and never before the step before it. The first
   * submission fixes the expected decision day from the processing time of the type version, when the officer did not give one.
   */
  async recordMilestone(tx: TenantTx, permitId: string, expectedVersion: number, input: MilestoneInput, actor: string): Promise<MilestoneChange> {
    const permit = await this.lock(tx, permitId, expectedVersion);
    const step = MILESTONE_STEPS.find((candidate) => candidate === input.stepCode);
    if (step === undefined) throw invalid('step_code');
    const rule = STEP_RULES[step];
    if (!rule.from.includes(permit.status)) throw stateInvalid();
    const plannedOn = input.plannedOn === undefined ? null : dateOf(input.plannedOn, 'planned_on');
    const actualOn = input.actualOn === undefined ? null : dateOf(input.actualOn, 'actual_on');
    if (plannedOn === null && actualOn === null) throw invalid('actual_on');
    if (rule.happened && actualOn === null) throw invalid('actual_on');
    if (actualOn !== null) await this.assertInOrder(tx, permitId, actualOn);
    const note = input.note === undefined ? null : textOf(input.note, 'note', MAX_TEXT);
    const documentVersionId = input.documentVersionId?.toLowerCase() ?? null;
    if (documentVersionId !== null) await this.assertDocument(tx, documentVersionId, 'document_version_id');
    const status = rule.to ?? permit.status;
    const submittedOn = step === 'SUBMITTED' ? actualOn : permit.submitted_on;
    const expectedDecisionOn =
      step === 'SUBMITTED' && permit.expected_decision_on === null && permit.default_processing_days !== null && actualOn !== null
        ? shiftDays(actualOn, permit.default_processing_days)
        : permit.expected_decision_on;
    const milestoneId = randomUUID();
    await tx.query(
      `insert into machvon.permit_milestone (tenant_id, id, permit_id, step_code, planned_on, actual_on, note, document_version_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::date, $5::date, $6, $7::uuid, $8::uuid)`,
      [milestoneId, permitId, step, plannedOn, actualOn, note, documentVersionId, actor],
    );
    await tx.query(
      `update machvon.permit set status = $2, submitted_on = $3::date, expected_decision_on = $4::date, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [permitId, status, submittedOn, expectedDecisionOn, actor],
    );
    return {
      ...changeOf(permit, status, permit.status, Number(permit.version) + 1),
      milestoneId,
      stepCode: step,
      plannedOn,
      actualOn,
      note,
      documentVersionId,
      expectedDecisionOn,
    };
  }

  /**
   * Decides an application that is in appraisal: ISSUED with its number, its days and its scan, or REJECTED with the reason (a rejected
   * application is never issued later: the next attempt is a new permit). The decision is recorded as a milestone too. A type that
   * already has a current permit in the dossier is 409 PERMIT_ALREADY_CURRENT, a number the type already uses is 409 PERMIT_NO_DUPLICATE.
   */
  async decide(tx: TenantTx, permitId: string, expectedVersion: number, input: DecisionInput, actor: string): Promise<DecisionChange> {
    const permit = await this.lock(tx, permitId, expectedVersion);
    if (input.outcome !== 'ISSUED' && input.outcome !== 'REJECTED') throw invalid('outcome');
    if (permit.status !== 'IN_APPRAISAL') throw stateInvalid();
    const asOf = this.dossiers.currentDate();
    const documentVersionId = input.documentVersionId?.toLowerCase() ?? null;
    if (documentVersionId !== null) await this.assertDocument(tx, documentVersionId, 'document_version_id');
    if (input.outcome === 'REJECTED') {
      const reason = textOf(input.reason ?? '', 'reason', MAX_TEXT);
      for (const [field, given] of [['permit_no', input.permitNo], ['issued_on', input.issuedOn], ['valid_from', input.validFrom], ['valid_until', input.validUntil]] as const) {
        if (given !== undefined) throw invalid(field);
      }
      if (input.noExpiry === true) throw invalid('no_expiry');
      await this.writeDecisionMilestone(tx, permitId, asOf, reason, documentVersionId, actor);
      await tx.query(`update machvon.permit set status = 'REJECTED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [permitId, actor]);
      const readiness = await this.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
      return { ...changeOf(permit, 'REJECTED', permit.status, Number(permit.version) + 1), outcome: 'REJECTED', issuedOn: null, documentVersionId, readiness };
    }
    if (documentVersionId === null) throw new DomainError('PERMIT_DOCUMENT_REQUIRED', 422, 'document_version_id');
    const issued = this.issuedTerms(permit, input, asOf);
    await this.assertNoCurrent(tx, permit);
    await this.assertNumberFree(tx, permit.type_code, issued.permitNo);
    await withUniqueClaim(tx, { constraint: CURRENT_CONSTRAINTS, code: 'PERMIT_ALREADY_CURRENT' }, async () => {
      try {
        await tx.query(
          `update machvon.permit set status = 'ISSUED', permit_no = $2, issued_on = $3::date, valid_from = $4::date, valid_until = $5::date, no_expiry = $6,
                  document_version_id = $7::uuid, updated_at = now(), updated_by = $8::uuid, version = version + 1 where id = $1::uuid`,
          [permitId, issued.permitNo, issued.issuedOn, issued.validFrom, issued.validUntil, issued.noExpiry, documentVersionId, actor],
        );
      } catch (error) {
        throw numberClash(error);
      }
    });
    await this.writeDecisionMilestone(tx, permitId, issued.issuedOn, null, documentVersionId, actor);
    const readiness = await this.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
    return {
      ...changeOf(permit, 'ISSUED', permit.status, Number(permit.version) + 1),
      permitNo: issued.permitNo,
      validFrom: issued.validFrom,
      validUntil: issued.validUntil,
      noExpiry: issued.noExpiry,
      outcome: 'ISSUED',
      issuedOn: issued.issuedOn,
      documentVersionId,
      readiness,
    };
  }

  /**
   * Replaces an issued (or expired) permit by a new one that is issued today (BR-PMT-01): the old one becomes SUPERSEDED and keeps
   * everything it says, including the permit type version it was issued under; the new one is written under the version of the type in
   * force today, with the new number and last day, and names the old one. The last day only ever moves later, never by editing.
   */
  async renew(tx: TenantTx, permitId: string, expectedVersion: number, input: RenewalInput, actor: string): Promise<RenewalChange> {
    const permit = await this.lock(tx, permitId, expectedVersion);
    if (permit.status !== 'ISSUED' && permit.status !== 'EXPIRED') throw stateInvalid();
    // A permit without an end is not renewed: there is nothing that runs out.
    if (permit.no_expiry) throw stateInvalid();
    const asOf = this.dossiers.currentDate();
    const permitNo = textOf(input.newPermitNo, 'new_permit_no', MAX_PERMIT_NO);
    const validUntil = dateOf(input.newValidUntil, 'new_valid_until');
    if (validUntil < asOf || (permit.valid_until !== null && validUntil <= permit.valid_until)) throw invalid('new_valid_until');
    const documentVersionId = input.documentVersionId.toLowerCase();
    await this.assertDocument(tx, documentVersionId, 'document_version_id');
    const current = await this.typeInForce(tx, permit.type_code, asOf);
    if (current === undefined) throw new DomainError('PERMIT_TYPE_NOT_EFFECTIVE', 422);
    await this.assertNumberFree(tx, permit.type_code, permitNo);
    await tx.query(`update machvon.permit set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [permitId, actor]);
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: CURRENT_CONSTRAINTS, code: 'PERMIT_ALREADY_CURRENT' }, async () => {
      try {
        await tx.query(
          `insert into machvon.permit
             (tenant_id, id, dossier_id, permit_type_id, permit_no, status, authority_name, issued_on, valid_from, valid_until, no_expiry, document_version_id,
              supersedes_id, responsible_membership_id, is_required, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, 'ISSUED', $5, $6::date, $6::date, $7::date, false, $8::uuid,
                   $9::uuid, $10::uuid, $11, $12::uuid, $12::uuid)`,
          [id, permit.dossier_id, current.id, permitNo, permit.authority_name, asOf, validUntil, documentVersionId, permitId, permit.responsible_membership_id, permit.is_required, actor],
        );
      } catch (error) {
        throw numberClash(error);
      }
    });
    await this.writeDecisionMilestone(tx, id, asOf, null, documentVersionId, actor);
    const readiness = await this.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
    return {
      id,
      dossierId: permit.dossier_id,
      permitTypeId: current.id,
      permitTypeCode: current.code,
      permitTypeRevision: current.revision,
      fromStatus: null,
      status: 'ISSUED',
      version: 1,
      permitNo,
      validFrom: asOf,
      validUntil,
      noExpiry: false,
      readiness,
      supersededId: permitId,
      supersededVersion: Number(permit.version) + 1,
      issuedOn: asOf,
      documentVersionId,
    };
  }

  /** Revokes an issued permit with the reason and the decision that took it back (an expired one is renewed or replaced, not revoked). */
  async revoke(tx: TenantTx, permitId: string, expectedVersion: number, input: RevocationInput, actor: string): Promise<RevocationChange> {
    const permit = await this.lock(tx, permitId, expectedVersion);
    if (permit.status !== 'ISSUED') throw stateInvalid();
    const reason = textOf(input.reason, 'reason', MAX_TEXT);
    const documentVersionId = input.decisionDocumentVersionId.toLowerCase();
    await this.assertDocument(tx, documentVersionId, 'decision_document_version_id');
    await tx.query(
      `update machvon.permit set status = 'REVOKED', revoke_reason = $2, revocation_document_version_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [permitId, reason, documentVersionId, actor],
    );
    const readiness = await this.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
    return { ...changeOf(permit, 'REVOKED', permit.status, Number(permit.version) + 1), reason, revocationDocumentVersionId: documentVersionId, readiness };
  }

  /**
   * Declares an exemption from a permit (PMT 4, BR-PMT-04, CXN-EXE-02): a planned or submitted permit of a type that allows it becomes EXEMPTED on a written
   * basis and the document that decided it, and counts as covering its type (the readiness of the dossier is counted again). The approver is not the
   * proposer: whoever created the permit or last changed it (the person who proposed it) cannot declare its exemption (403 SELF_APPROVAL_DENIED). A type that
   * does not allow it is 422 EXEMPTION_NOT_ALLOWED, a permit in another state 409 PERMIT_STATE_INVALID, a type that already has a current permit in the dossier
   * 409 PERMIT_ALREADY_CURRENT. The decision is recorded as a milestone too, with the document.
   */
  async exempt(tx: TenantTx, permitId: string, expectedVersion: number, input: ExemptionInput, actor: string): Promise<ExemptionChange> {
    const permit = await this.lock(tx, permitId, expectedVersion);
    if (permit.status !== 'PLANNED' && permit.status !== 'SUBMITTED') throw stateInvalid();
    if (!permit.exemption_allowed) throw new DomainError('EXEMPTION_NOT_ALLOWED', 422);
    if (actor === permit.created_by || actor === permit.updated_by) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const basis = textOf(input.basis, 'exemption_basis', MAX_TEXT);
    const documentVersionId = input.decisionDocumentVersionId.toLowerCase();
    await this.assertDocument(tx, documentVersionId, 'exemption_decision_document_version_id');
    await this.assertNoCurrent(tx, permit);
    await withUniqueClaim(tx, { constraint: CURRENT_CONSTRAINTS, code: 'PERMIT_ALREADY_CURRENT' }, () =>
      tx.query(
        `update machvon.permit set status = 'EXEMPTED', exemption_basis = $2, exemption_decision_document_version_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [permitId, basis, documentVersionId, actor],
      ),
    );
    const exemptedOn = this.dossiers.currentDate();
    await this.writeDecisionMilestone(tx, permitId, exemptedOn, null, documentVersionId, actor);
    const readiness = await this.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
    return { ...changeOf(permit, 'EXEMPTED', permit.status, Number(permit.version) + 1), decisionDocumentVersionId: documentVersionId, exemptedOn, readiness };
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  /** Serialises the commands on one dossier: the checks of a command read what a sibling is about to write. */
  private async lockDossier(tx: TenantTx, dossierId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.permit_dossier where id = $1::uuid for update', [dossierId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  /** The permit locked, after its dossier, and checked against the version the caller saw. */
  private async lock(tx: TenantTx, permitId: string, expectedVersion: number): Promise<PermitSql> {
    const owner = await tx.query<{ dossier_id: string }>('select dossier_id from machvon.permit where id = $1::uuid', [permitId]);
    if (owner[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockDossier(tx, owner[0].dossier_id);
    const rows = await tx.query<PermitSql>(
      `select x.id, x.dossier_id, x.permit_type_id, t.code as type_code, t.revision as type_revision, t.default_validity_months, t.default_processing_days,
              x.status, x.version::text as version, x.permit_no, x.issued_on::text as issued_on, x.valid_from::text as valid_from, x.valid_until::text as valid_until,
              x.no_expiry, x.is_required, x.authority_name, x.responsible_membership_id, x.submitted_on::text as submitted_on,
              x.expected_decision_on::text as expected_decision_on, x.document_version_id, t.exemption_allowed, x.created_by, x.updated_by
         from machvon.permit x join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
        where x.id = $1::uuid for update of x`,
      [permitId],
    );
    const permit = rows[0];
    if (permit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(permit.version) !== expectedVersion) throw versionConflict(Number(permit.version));
    return permit;
  }

  private async typeOf(tx: TenantTx, id: string): Promise<TypeSql | undefined> {
    const rows = await tx.query<TypeSql>(
      `select id, code, revision, status, authority_text, default_validity_months, default_processing_days, effective_from::text as effective_from, effective_until::text as effective_until
         from machvon.permit_type where id = $1::uuid`,
      [id],
    );
    return rows[0];
  }

  /** The version of a code that applies on a day (the first and the last day both count), or undefined. */
  private async typeInForce(tx: TenantTx, code: string, asOf: string): Promise<TypeSql | undefined> {
    const rows = await tx.query<TypeSql>(
      `select id, code, revision, status, authority_text, default_validity_months, default_processing_days, effective_from::text as effective_from, effective_until::text as effective_until
         from machvon.permit_type where code = $1 and status <> 'DRAFT' and effective_from <= $2::date and (effective_until is null or effective_until >= $2::date)`,
      [code, asOf],
    );
    return rows[0];
  }

  private async assertDocument(tx: TenantTx, documentVersionId: string, field: string): Promise<void> {
    const rows = await tx.query<{ found: boolean }>("select exists (select 1 from machvon.document_version where id = $1::uuid and scan_status <> 'INFECTED') as found", [documentVersionId]);
    if (rows[0]?.found !== true) throw invalid(field);
  }

  /** A step that happened is not dated before the one that happened before it, and not in the days to come. */
  private async assertInOrder(tx: TenantTx, permitId: string, actualOn: string): Promise<void> {
    if (actualOn > this.dossiers.currentDate()) throw invalid('actual_on');
    const rows = await tx.query<{ last: string | null }>('select max(actual_on)::text as last from machvon.permit_milestone where permit_id = $1::uuid', [permitId]);
    const last = rows[0]?.last ?? null;
    if (last !== null && actualOn < last) throw invalid('actual_on');
  }

  private async assertNoCurrent(tx: TenantTx, permit: PermitSql): Promise<void> {
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2 and status in ('ISSUED', 'EXEMPTED') and id <> $3::uuid limit 1`,
      [permit.dossier_id, permit.type_code, permit.id],
    );
    if (rows[0] !== undefined) throw new DomainError('PERMIT_ALREADY_CURRENT', 409);
  }

  private async assertNumberFree(tx: TenantTx, typeCode: string, permitNo: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.permit where permit_type_code = $1 and lower(permit_no) = lower($2) limit 1', [typeCode, permitNo]);
    if (rows[0] !== undefined) throw new DomainError('PERMIT_NO_DUPLICATE', 409);
  }

  /** The terms of an issued permit as they will be stored, every rule of the table checked before the database is touched. */
  private issuedTerms(permit: PermitSql, input: DecisionInput, asOf: string): { permitNo: string; issuedOn: string; validFrom: string; validUntil: string | null; noExpiry: boolean } {
    const permitNo = textOf(input.permitNo ?? '', 'permit_no', MAX_PERMIT_NO);
    const validFromGiven = input.validFrom === undefined ? null : dateOf(input.validFrom, 'valid_from');
    const issuedOn = input.issuedOn === undefined ? (validFromGiven ?? asOf) : dateOf(input.issuedOn, 'issued_on');
    if (issuedOn > asOf) throw invalid('issued_on');
    const validFrom = validFromGiven ?? issuedOn;
    const noExpiry = input.noExpiry === true;
    if (noExpiry && input.validUntil !== undefined) throw invalid('valid_until');
    let validUntil: string | null = null;
    if (!noExpiry) {
      validUntil =
        input.validUntil !== undefined
          ? dateOf(input.validUntil, 'valid_until')
          : permit.default_validity_months === null
            ? null
            : validityEnd(validFrom, permit.default_validity_months);
      if (validUntil === null || validUntil < validFrom) throw invalid('valid_until');
    }
    return { permitNo, issuedOn, validFrom, validUntil, noExpiry };
  }

  private async writeDecisionMilestone(tx: TenantTx, permitId: string, on: string, note: string | null, documentVersionId: string | null, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.permit_milestone (tenant_id, id, permit_id, step_code, actual_on, note, document_version_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'DECISION', $3::date, $4, $5::uuid, $6::uuid)`,
      [randomUUID(), permitId, on, note, documentVersionId, actor],
    );
  }
}

/** Whether a type version applies on a day: not a draft, from its first day to its last day inclusive. */
function inForce(type: TypeSql, asOf: string): boolean {
  return type.status !== 'DRAFT' && type.effective_from <= asOf && (type.effective_until === null || type.effective_until >= asOf);
}

/** The refusal of a number the type already uses, when the unique index says so before the check above could see it. */
function numberClash(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint !== undefined && (NUMBER_CONSTRAINTS as readonly string[]).includes(constraint) ? new DomainError('PERMIT_NO_DUPLICATE', 409) : error;
}

function blank(id: string, dossierId: string, type: TypeSql): Omit<PermitChange, 'fromStatus' | 'status' | 'version' | 'readiness'> {
  return { id, dossierId, permitTypeId: type.id, permitTypeCode: type.code, permitTypeRevision: type.revision, permitNo: null, validFrom: null, validUntil: null, noExpiry: false };
}

function changeOf(permit: PermitSql, status: PermitStatus, fromStatus: PermitStatus, version: number): PermitChange {
  return {
    id: permit.id,
    dossierId: permit.dossier_id,
    permitTypeId: permit.permit_type_id,
    permitTypeCode: permit.type_code,
    permitTypeRevision: permit.type_revision,
    fromStatus,
    status,
    version,
    permitNo: permit.permit_no,
    validFrom: permit.valid_from,
    validUntil: permit.valid_until,
    noExpiry: permit.no_expiry,
    readiness: null,
  };
}
