import { createHash } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { linkWarrantyIssue } from './ast-claim-store.ts';
import { IssIssueStore } from './iss-issue-store.ts';
import type { CreatedIssue, IssueSource } from './iss-issue-store.ts';
import { ISSUE_CATEGORY_TYPE, SLA_SEVERITIES } from './iss-sla-policy-store.ts';
import { linkComplaintIssue } from './lnd-complaint-store.ts';
import { linkStageIssue } from './lnd-stage-progress-store.ts';
import { linkReconciliationIssue } from './pay-reconciliation-store.ts';
import type { SlaSeverity } from './iss-sla-policy-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * How an event of another module becomes an issue (ISS 3.1 step 8, ISS-11). One row per event type: the module the issue is attributed to, the title of the
 * kind of problem, the severity when the event names none, the business key of the issue category the tenant keeps for it (MDM-17) and the event members the
 * intake reads. The events of PMT, PAY and LND carry the members of the common contract below; CTR's `ctr.guarantee.expired.v1` was written before it and is read
 * by its own members. Nothing else of a payload is read: the intake copies a reference code and ids, never a name, an identity number, an address or a text.
 */
export interface IntakeSpec {
  eventType: string;
  sourceModule: Extract<IssueSource, 'LND' | 'PMT' | 'PAY' | 'CTR' | 'AST'>;
  /** The kind of problem, in the words of the title of the issue. */
  title: string;
  severity: SlaSeverity;
  /** The business key of the ISSUE_CATEGORY entry the issues of this event are filed under. */
  categoryKey: string;
  /** Whether the event asks for an issue at all (CTR sends `issue_required`); an event that does not is left alone. */
  wanted: (payload: Record<string, unknown>) => boolean;
  sourceRefId: (payload: Record<string, unknown>) => unknown;
  referenceCode: (payload: Record<string, unknown>) => unknown;
  /** What the source object remembers of the issue that was opened for it, in the transaction that opens it (the late stage of LND keeps the issue that holds it up). */
  link?: (tx: TenantTx, sourceRefId: string, issueId: string) => Promise<void>;
}

const alwaysWanted = (): boolean => true;
const commonRef = (payload: Record<string, unknown>): unknown => payload.source_ref_id;
const commonCode = (payload: Record<string, unknown>): unknown => payload.reference_code;

/** The category business keys the intake files issues under; a tenant defines them in master data, and an event whose category is missing is retried, then dead-lettered. */
export const INTAKE_CATEGORY_KEYS = { LND: 'LAND_CLEARANCE', PMT: 'PERMIT', PAY: 'PAYMENT', CTR: 'CONTRACT_GUARANTEE', AST: 'WARRANTY' } as const;

export const INTAKE_SPECS: readonly IntakeSpec[] = [
  {
    eventType: 'ctr.guarantee.expired.v1',
    sourceModule: 'CTR',
    title: 'Advance guarantee expired',
    severity: 'HIGH',
    categoryKey: INTAKE_CATEGORY_KEYS.CTR,
    wanted: (payload) => payload.issue_required === true,
    sourceRefId: (payload) => payload.source_reference,
    referenceCode: (payload) => (typeof payload.kind === 'string' && typeof payload.expires_on === 'string' ? `${payload.kind}-${payload.expires_on}` : undefined),
  },
  { eventType: 'pmt.permit.expired.v1', sourceModule: 'PMT', title: 'Permit expired', severity: 'HIGH', categoryKey: INTAKE_CATEGORY_KEYS.PMT, wanted: alwaysWanted, sourceRefId: commonRef, referenceCode: commonCode },
  { eventType: 'pay.advance.overdue.v1', sourceModule: 'PAY', title: 'Advance overdue', severity: 'HIGH', categoryKey: INTAKE_CATEGORY_KEYS.PAY, wanted: alwaysWanted, sourceRefId: commonRef, referenceCode: commonCode },
  {
    eventType: 'pay.reconciliation.overdue.v1',
    sourceModule: 'PAY',
    title: 'Reconciliation item overdue',
    severity: 'MEDIUM',
    categoryKey: INTAKE_CATEGORY_KEYS.PAY,
    wanted: alwaysWanted,
    sourceRefId: commonRef,
    referenceCode: commonCode,
    link: linkReconciliationIssue,
  },
  { eventType: 'pay.settlement.overdue.v1', sourceModule: 'PAY', title: 'Settlement verification overdue', severity: 'HIGH', categoryKey: INTAKE_CATEGORY_KEYS.PAY, wanted: alwaysWanted, sourceRefId: commonRef, referenceCode: commonCode },
  { eventType: 'lnd.complaint.filed.v1', sourceModule: 'LND', title: 'Land complaint filed', severity: 'MEDIUM', categoryKey: INTAKE_CATEGORY_KEYS.LND, wanted: alwaysWanted, sourceRefId: commonRef, referenceCode: commonCode, link: linkComplaintIssue },
  {
    eventType: 'lnd.deadline.breached.v1',
    sourceModule: 'LND',
    title: 'Land clearance deadline breached',
    severity: 'HIGH',
    categoryKey: INTAKE_CATEGORY_KEYS.LND,
    wanted: alwaysWanted,
    sourceRefId: commonRef,
    referenceCode: commonCode,
  },
  {
    eventType: 'lnd.stage.late.v1',
    sourceModule: 'LND',
    title: 'Land clearance stage late',
    severity: 'MEDIUM',
    categoryKey: INTAKE_CATEGORY_KEYS.LND,
    wanted: alwaysWanted,
    sourceRefId: commonRef,
    referenceCode: commonCode,
    link: linkStageIssue,
  },
  {
    eventType: 'ast.warranty_claim.overdue.v1',
    sourceModule: 'AST',
    title: 'Warranty claim unanswered',
    severity: 'HIGH',
    categoryKey: INTAKE_CATEGORY_KEYS.AST,
    wanted: alwaysWanted,
    sourceRefId: commonRef,
    referenceCode: commonCode,
    link: linkWarrantyIssue,
  },
];

export const INTAKE_EVENT_TYPES: readonly string[] = INTAKE_SPECS.map((spec) => spec.eventType);

/** The members of a payload that name a person, a household or a place: a producer must not send them, and the intake never reads them. */
export const PERSONAL_MEMBERS: readonly string[] = ['name', 'full_name', 'household_name', 'owner_name', 'complainant', 'citizen_id', 'national_id', 'cccd', 'id_number', 'address', 'phone', 'email', 'content', 'description'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A code of the source module: letters, digits and the separators of a code, at the start a letter or a digit, no spaces. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,39}$/;
/** An identity number of 9 or 12 digits is not a reference code, whatever the producer called it. */
const IDENTITY_NUMBER = /^(\d{9}|\d{12})$/;

/** What the intake needs to open an issue: ids, the severity and a reference code. */
export interface IntakeRequest {
  spec: IntakeSpec;
  sourceRefId: string;
  projectId: string;
  contractId?: string;
  ownerUnitId?: string;
  severity: SlaSeverity;
  /** A code of the source object (a complaint number, a permit number) that is safe to show; the first characters of the source id when the producer sent none that is. */
  referenceCode: string;
  /** The payload named a reference that could be a person's data, and the intake used the source id instead. */
  referenceReplaced: boolean;
}

export type IntakeReading = { kind: 'REQUEST'; request: IntakeRequest } | { kind: 'NOT_WANTED' } | { kind: 'INVALID' };

const uuidOf = (value: unknown): string | undefined => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined);

/** Reads the payload of an intake event: the members it may read, each judged; anything that is not a well formed request is INVALID, and one the event does not ask for is NOT_WANTED. */
export function readIntake(eventType: string, payload: Record<string, unknown>): IntakeReading {
  const spec = INTAKE_SPECS.find((candidate) => candidate.eventType === eventType);
  if (spec === undefined) return { kind: 'INVALID' };
  if (!spec.wanted(payload)) return { kind: 'NOT_WANTED' };
  const sourceRefId = uuidOf(spec.sourceRefId(payload));
  const projectId = uuidOf(payload.project_id);
  if (sourceRefId === undefined || projectId === undefined) return { kind: 'INVALID' };
  const contractId = payload.contract_id === undefined || payload.contract_id === null ? undefined : uuidOf(payload.contract_id);
  const ownerUnitId = payload.owner_unit_id === undefined || payload.owner_unit_id === null ? undefined : uuidOf(payload.owner_unit_id);
  if ((payload.contract_id !== undefined && payload.contract_id !== null && contractId === undefined) || (payload.owner_unit_id !== undefined && payload.owner_unit_id !== null && ownerUnitId === undefined)) {
    return { kind: 'INVALID' };
  }
  const severity = SLA_SEVERITIES.find((candidate) => candidate === payload.severity) ?? spec.severity;
  const sent = spec.referenceCode(payload);
  const usable = typeof sent === 'string' && CODE.test(sent) && !IDENTITY_NUMBER.test(sent);
  return {
    kind: 'REQUEST',
    request: {
      spec,
      sourceRefId,
      projectId,
      ...(contractId === undefined ? {} : { contractId }),
      ...(ownerUnitId === undefined ? {} : { ownerUnitId }),
      severity,
      referenceCode: usable ? sent : sourceRefId.slice(0, 8),
      referenceReplaced: sent !== undefined && !usable,
    },
  };
}

/** The operation id of the issue an event opens: the same for the same delivery, so a delivery that is retried after a crash opens the same issue (issue_client_operation_uq). */
export function intakeOperationId(eventId: string): string {
  const hex = createHash('sha256').update(`iss-intake:${eventId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type IntakeOutcome = { kind: 'OPENED'; issue: CreatedIssue } | { kind: 'DUPLICATE' } | { kind: 'PROJECT_UNKNOWN' };

/**
 * Opens the issue of an intake event (ISS 3.1 step 8): under the SLA policy in force for the category of the source, in the unit that owns the project (or the unit the
 * event names), attributed to the source module and object. There is at most one issue that is not closed per source object (BR-ISS-07): the second event for it
 * finds the first and changes nothing. The title and the description hold the kind of problem, the reference code and the category, nothing a person said.
 */
export class IssIntake {
  private readonly issues: IssIssueStore;

  constructor(issues: IssIssueStore = new IssIssueStore()) {
    this.issues = issues;
  }

  async open(tx: TenantTx, request: IntakeRequest, eventId: string, actor: string, now: Date): Promise<IntakeOutcome> {
    const projects = await tx.query<{ owner_unit_id: string }>('select owner_unit_id from machvon.project where id = $1::uuid', [request.projectId]);
    const project = projects[0];
    if (project === undefined) return { kind: 'PROJECT_UNKNOWN' };
    const categories = await tx.query<{ current_version_id: string }>(
      `select r.current_version_id from machvon.master_record r where r.master_type = $1 and r.business_key = $2 and r.status = 'EFFECTIVE' and r.current_version_id is not null`,
      [ISSUE_CATEGORY_TYPE, request.spec.categoryKey],
    );
    const category = categories[0];
    // The tenant has not defined the category of this source yet: the delivery fails and is retried, then dead-lettered where the owner of the module sees it.
    if (category === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'category_key');
    const title = `${request.spec.title}: ${request.referenceCode}`;
    try {
      const issue = await this.issues.create(
        tx,
        {
          projectId: request.projectId,
          categoryVersionId: category.current_version_id,
          severity: request.severity,
          title,
          description: `${title} (${request.spec.sourceModule}, ${request.spec.categoryKey})`,
          ...(request.contractId === undefined ? {} : { contractId: request.contractId }),
          ownerUnitId: request.ownerUnitId ?? project.owner_unit_id,
          sourceModule: request.spec.sourceModule,
          sourceRefId: request.sourceRefId,
          clientOperationId: intakeOperationId(eventId),
        },
        actor,
        now,
        () => undefined,
      );
      if (!issue.replayed) await request.spec.link?.(tx, request.sourceRefId, issue.id);
      // The same delivery again (a crash between the issue and the inbox row cannot happen, they share a transaction) answers the issue that exists.
      return issue.replayed ? { kind: 'DUPLICATE' } : { kind: 'OPENED', issue };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'DUPLICATE_SOURCE_OPEN') return { kind: 'DUPLICATE' };
      throw error;
    }
  }
}

