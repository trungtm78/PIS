import type { PaymentRequestView } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { formsMissing, isEditable } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface PaymentPermissions {
  create: string;
  attach: string;
  cancel: string;
  submit: string;
  verify: string;
  return: string;
  generateForms: string;
  sendTreasury: string;
  /** The right to approve an exception, which is what lets a duplicate invoice through. */
  override: string;
}

export interface PaymentActions {
  revise: boolean;
  attach_document: boolean;
  cancel: boolean;
  override_duplicate: boolean;
  submit: boolean;
  verify: boolean;
  return: boolean;
  generate_forms: boolean;
  send_treasury: boolean;
}

/**
 * What the caller may do with the request as it stands: it is a draft or has been returned, the caller holds the permission over the contract, and (for a duplicate invoice) is a person the
 * contract trusts with exceptions and is not the one who drafted it. A button is shown for exactly these; the server judges each command again.
 */
export function paymentActionsOf(view: PaymentRequestView, access: EffectiveAccess, now: Date, permissions: PaymentPermissions, viewer: string): PaymentActions {
  const refs = placeRefs(view.reach);
  const editable = isEditable(view.status);
  const is = (person: string | null): boolean => person !== null && person.toLowerCase() === viewer.toLowerCase();
  const mine = is(view.createdBy);
  return {
    revise: editable && reaches(access, permissions.create, refs, now),
    attach_document: editable && reaches(access, permissions.attach, refs, now),
    cancel: editable && !view.claimsAcceptance && reaches(access, permissions.cancel, refs, now),
    override_duplicate: editable && reaches(access, permissions.attach, refs, now) && reaches(access, permissions.override, refs, now) && !mine,
    submit: view.status === 'DRAFT' && reaches(access, permissions.submit, refs, now),
    // Whoever drew a request up or sent it does not check it (the server refuses them anyway).
    verify: view.status === 'SUBMITTED' && reaches(access, permissions.verify, refs, now) && !mine && !is(view.submittedBy),
    return: (view.status === 'SUBMITTED' || view.status === 'VERIFIED') && reaches(access, permissions.return, refs, now),
    generate_forms: view.status === 'VERIFIED' && reaches(access, permissions.generateForms, refs, now),
    // The file goes to the Treasury with a standing form of each of the four kinds; the server judges it again.
    send_treasury: view.status === 'VERIFIED' && formsMissing(view.formsStanding).length === 0 && reaches(access, permissions.sendTreasury, refs, now),
  };
}

/**
 * A payment request as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. The contractor of the contract (a
 * guest) sees the request and its figures but not who drafted it nor how many other drafts there are of the acceptance, which are the owner's working notes.
 */
export function paymentView(view: PaymentRequestView, actions: PaymentActions, guest: boolean): Record<string, unknown> {
  return {
    id: view.id,
    request_no: view.requestNo,
    request_kind: view.requestKind,
    status: view.status,
    contract: { id: view.contract.id, code: view.contract.code, status: view.contract.status },
    project_id: view.projectId,
    acceptance: view.acceptance === null ? null : { id: view.acceptance.id, acceptance_no: view.acceptance.acceptanceNo, accepted_on: view.acceptance.acceptedOn },
    advance_id: view.advanceId,
    settlement_revision_id: view.settlementRevisionId,
    allocation_line_id: view.allocationLineId,
    plan_year: view.planYear,
    gross_vnd: view.grossVnd,
    advance_recovery_vnd: view.advanceRecoveryVnd,
    retention_vnd: view.retentionVnd,
    tax_adjustment_vnd: view.taxAdjustmentVnd,
    tax_adjustment_basis: view.taxAdjustmentBasis,
    advance_recovery_extra_vnd: view.advanceRecoveryExtraVnd,
    net_vnd: view.netVnd,
    claims_acceptance: view.claimsAcceptance,
    other_drafts: guest ? null : view.otherDrafts,
    return_reason: view.returnReason,
    cancel_reason: view.cancelReason,
    created_by: guest ? null : view.createdBy,
    submitted_by: guest ? null : view.submittedBy,
    submitted_at: view.submittedAt,
    verified_by: guest ? null : view.verifiedBy,
    verification_note: guest ? null : view.verificationNote,
    treasury_submitted_on: view.treasurySubmittedOn,
    treasury_ref: guest ? null : view.treasuryRef,
    treasury_paid_on: view.treasuryPaidOn,
    forms_standing: view.formsStanding,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    lines: view.lines.map((line) => ({
      id: line.id,
      acceptance_line_id: line.acceptanceLineId,
      boq_item: { id: line.boqItemId, business_key: line.boqItemKey, description: line.description, unit_code: line.unitCode },
      party_id: line.partyId,
      quantity: line.quantity,
      unit_price_snapshot: line.unitPrice,
      retention_pct_snapshot: line.retentionPct,
      gross_vnd: line.grossVnd,
      advance_recovery_vnd: line.advanceRecoveryVnd,
      retention_vnd: line.retentionVnd,
      net_vnd: line.netVnd,
    })),
    documents: view.documents.map((document) => ({
      id: document.id,
      document_version_id: document.documentVersionId,
      doc_kind: document.docKind,
      checksum: document.checksum,
      invoice_no: document.invoiceNo,
      invoice_date: document.invoiceDate,
      signed: document.signed,
      duplicate_override_reason: document.duplicateOverrideReason,
      duplicate_override_by: guest ? null : document.duplicateOverrideBy,
      created_by: guest ? null : document.createdBy,
      created_at: document.createdAt,
    })),
    actions,
    version: view.version,
  };
}
