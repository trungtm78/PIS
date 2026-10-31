import { DomainError } from '@machvon/kernel';
import type { DossierStatus, RetentionClass, RetentionRuleSet, RetentionRuleView, RetentionStartBasis } from '@machvon/kernel';
import { TIMESTAMP } from './ctr-contract-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface DossierRecord {
  id: string;
  dossierCode: string;
  year: number;
  title: string;
  organizationUnitId: string;
  unitName: string | null;
  unitPath: string;
  subjectModule: string | null;
  subjectId: string | null;
  categoryCode: string;
  retentionRuleId: string | null;
  retentionRuleSet: RetentionRuleSet | null;
  retentionClassCode: RetentionClass | null;
  provisional: boolean;
  retentionEndsOn: string | null;
  status: DossierStatus;
  closedAt: string | null;
  settlementClosedOn: string | null;
  handoverDueOn: string | null;
  /** The handover to the archive: when, where to (the reference the archive gave) and who handed it over. */
  handedOverAt: string | null;
  archiveRef: string | null;
  handedOverBy: string | null;
  /** A disposal that was proposed: by whom, when, why and from which state; and, once decided, who decided, when, with which decision of the council and what they wrote. */
  disposal: DisposalRecord | null;
  itemCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The days before the due day at which the archivists are reminded of a handover (DOC.md job `doc.handover-due`). */
export type HandoverReminderStage = 30 | 7 | 1;

export interface DisposalRecord {
  proposedBy: string;
  proposedAt: string;
  reason: string;
  fromStatus: DossierStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  councilDecisionDocumentId: string | null;
  comment: string | null;
}

export interface DossierItemRecord {
  id: string;
  documentId: string;
  ordinal: number;
  title: string;
  docKind: string;
  docTypeCode: string;
  classification: string;
  issuedOn: string | null;
  addedAt: string;
}

export interface NewDossier {
  dossierCode: string;
  year: number;
  title: string;
  organizationUnitId: string;
  subjectModule: string | undefined;
  subjectId: string | undefined;
  categoryCode: string;
  actor: string;
}

export interface DossierFilters {
  status?: string | undefined;
  subjectModule?: string | undefined;
  subjectId?: string | undefined;
  year?: number | undefined;
}

export interface DossierPageAnchor {
  code: string;
  id: string;
}

/** A document as filing sees it: what it is, who issued it, and where it stands in its own chain. */
export interface FileableDocument {
  id: string;
  docKind: string;
  title: string;
  issuerUnitId: string | null;
  issuerUnitPath: string | null;
  outgoingStatus: string | null;
  incomingId: string | null;
  incomingStatus: string | null;
}

export interface RetentionRuleRecord extends RetentionRuleView {
  legalBasis: string;
  legalConfirmationRef: string | null;
  endAction: string;
  /** Who drafted, published and confirmed the rule (the four-eyes trail the policy screen shows), with their names. */
  createdBy: string;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  legalConfirmedBy: string | null;
  legalConfirmedByName: string | null;
  version: number;
}

export interface RuleFilters {
  ruleSet?: string | undefined;
  categoryCode?: string | undefined;
}

interface Row {
  id: string;
  dossier_code: string;
  year: number;
  title: string;
  organization_unit_id: string;
  unit_name: string | null;
  unit_path: string;
  subject_module: string | null;
  subject_id: string | null;
  category_code: string;
  retention_rule_id: string | null;
  retention_rule_set: RetentionRuleSet | null;
  retention_class_code: RetentionClass | null;
  provisional_retention: boolean;
  retention_ends_on: string | null;
  status: DossierStatus;
  closed_at: string | null;
  settlement_closed_on: string | null;
  handover_due_on: string | null;
  handed_over_at: string | null;
  archive_ref: string | null;
  handed_over_by: string | null;
  disposal_proposed_by: string | null;
  disposal_proposed_at: string | null;
  disposal_reason: string | null;
  disposal_from_status: DossierStatus | null;
  disposal_decided_by: string | null;
  disposal_decided_at: string | null;
  disposal_decision_document_id: string | null;
  disposal_comment: string | null;
  item_count: string;
  version: string;
  created_at: string;
  updated_at: string;
  sort_key: string;
}

const FROM = `machvon.dossier d
  join machvon.organization_unit ou on ou.tenant_id = d.tenant_id and ou.id = d.organization_unit_id
  left join machvon.doc_retention_rule r on r.tenant_id = d.tenant_id and r.id = d.retention_rule_id`;

/** The columns of the owning unit that a scope predicate over the dossiers is compiled against. */
export const DOSSIER_SCOPE_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;

const COLUMNS = `d.id, d.dossier_code, d.year, d.title, d.organization_unit_id, ou.name as unit_name, ou.path as unit_path, d.subject_module, d.subject_id, d.category_code, d.retention_rule_id, r.rule_set as retention_rule_set,
  d.retention_class_code, d.provisional_retention, d.retention_ends_on::text as retention_ends_on, d.status, ${TIMESTAMP('d.closed_at')} as closed_at, d.settlement_closed_on::text as settlement_closed_on,
  d.handover_due_on::text as handover_due_on, ${TIMESTAMP('d.handed_over_at')} as handed_over_at, d.archive_ref, d.handed_over_by, d.disposal_proposed_by, ${TIMESTAMP('d.disposal_proposed_at')} as disposal_proposed_at, d.disposal_reason, d.disposal_from_status,
  d.disposal_decided_by, ${TIMESTAMP('d.disposal_decided_at')} as disposal_decided_at, d.disposal_decision_document_id, d.disposal_comment, (select count(*) from machvon.dossier_item i where i.tenant_id = d.tenant_id and i.dossier_id = d.id)::text as item_count, d.version::text as version,
  ${TIMESTAMP('d.created_at')} as created_at, ${TIMESTAMP('d.updated_at')} as updated_at, to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toRecord = (row: Row): DossierRecord => ({
  id: row.id,
  dossierCode: row.dossier_code,
  year: row.year,
  title: row.title,
  organizationUnitId: row.organization_unit_id,
  unitName: row.unit_name,
  unitPath: row.unit_path,
  subjectModule: row.subject_module,
  subjectId: row.subject_id,
  categoryCode: row.category_code,
  retentionRuleId: row.retention_rule_id,
  retentionRuleSet: row.retention_rule_set,
  retentionClassCode: row.retention_class_code,
  provisional: row.provisional_retention,
  retentionEndsOn: row.retention_ends_on,
  status: row.status,
  closedAt: row.closed_at,
  settlementClosedOn: row.settlement_closed_on,
  handoverDueOn: row.handover_due_on,
  handedOverAt: row.handed_over_at,
  archiveRef: row.archive_ref,
  handedOverBy: row.handed_over_by,
  disposal:
    row.disposal_proposed_by === null || row.disposal_proposed_at === null || row.disposal_reason === null || row.disposal_from_status === null
      ? null
      : {
          proposedBy: row.disposal_proposed_by,
          proposedAt: row.disposal_proposed_at,
          reason: row.disposal_reason,
          fromStatus: row.disposal_from_status,
          decidedBy: row.disposal_decided_by,
          decidedAt: row.disposal_decided_at,
          councilDecisionDocumentId: row.disposal_decision_document_id,
          comment: row.disposal_comment,
        },
  itemCount: Number(row.item_count),
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface RuleRow {
  id: string;
  rule_set: RetentionRuleSet;
  category_code: string;
  class_code: RetentionClass;
  retention_years: number | null;
  start_basis: RetentionStartBasis;
  handover_months: number;
  confirmation_status: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  precedence: number;
  effective_from: string;
  effective_until: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  legal_basis: string;
  legal_confirmation_ref: string | null;
  end_action: string;
  created_by: string;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  legal_confirmed_by: string | null;
  legal_confirmed_by_name: string | null;
  version: string;
  sort_key: string;
}

/** The display name of a member named in a column of the rule (the directory view: the table of accounts is not the application's to read). */
const ruleActorName = (column: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = machvon.doc_retention_rule.tenant_id and d.membership_id = machvon.doc_retention_rule.${column})`;

const RULE_COLUMNS = `id, rule_set, category_code, class_code, retention_years, start_basis, handover_months, confirmation_status, precedence, effective_from::text as effective_from, effective_until::text as effective_until,
  status, legal_basis, legal_confirmation_ref, end_action, created_by, approved_by, legal_confirmed_by, ${ruleActorName('created_by')} as created_by_name, ${ruleActorName('approved_by')} as approved_by_name,
  ${ruleActorName('legal_confirmed_by')} as legal_confirmed_by_name, version::text as version, category_code || '|' || id::text as sort_key`;

const toRule = (row: RuleRow): RetentionRuleRecord => ({
  id: row.id,
  ruleSet: row.rule_set,
  categoryCode: row.category_code,
  classCode: row.class_code,
  retentionYears: row.retention_years,
  startBasis: row.start_basis,
  handoverMonths: row.handover_months,
  confirmationStatus: row.confirmation_status,
  precedence: row.precedence,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  status: row.status,
  legalBasis: row.legal_basis,
  legalConfirmationRef: row.legal_confirmation_ref,
  endAction: row.end_action,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  approvedBy: row.approved_by,
  approvedByName: row.approved_by_name,
  legalConfirmedBy: row.legal_confirmed_by,
  legalConfirmedByName: row.legal_confirmed_by_name,
  version: Number(row.version),
});

/**
 * The table gateway of the dossiers (ST-DOC-013, DOC.md F11). A dossier is opened, gets its documents once each, and is closed once; closing writes the retention that applies and the database does not let it be
 * rewritten (trigger `dossier_guard`). Who may do what and which rule is chosen are the business of the controller and of the kernel.
 */
export class DocDossierStore {
  async find(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<DossierRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where d.id = $1::uuid and ${predicate?.sql ?? 'true'}`, [id, ...(predicate?.params ?? [])]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The dossier locked for a change, in the scope of the caller. */
  async lock(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<DossierRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where d.id = $1::uuid and ${predicate?.sql ?? 'true'} for update of d`, [id, ...(predicate?.params ?? [])]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The dossiers in the scope of the caller, the latest first; the cursor is the moment of creation and the id of the last one. */
  async list(tx: TenantTx, filters: DossierFilters, page: { limit: number; after: DossierPageAnchor | undefined }, scope?: ScopeBuilder): Promise<{ records: DossierRecord[]; next: DossierPageAnchor | undefined }> {
    assertTimestampCursor(page.after?.code);
    const predicate = scope?.(8);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ${predicate?.sql ?? 'true'} and ($1::text is null or d.status = $1) and ($2::text is null or d.subject_module = $2) and ($3::uuid is null or d.subject_id = $3::uuid) and ($4::int is null or d.year = $4::int)
          and ($5::timestamptz is null or (d.created_at, d.id) < ($5::timestamptz, $6::uuid))
        order by d.created_at desc, d.id desc limit $7::int`,
      [filters.status ?? null, filters.subjectModule ?? null, filters.subjectId ?? null, filters.year ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit + 1, ...(predicate?.params ?? [])],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toRecord), next: rows.length > page.limit && last !== undefined ? { code: last.sort_key, id: last.id } : undefined };
  }

  /** Opens a dossier; the code is unique in its year (409 `DOSSIER_CODE_DUPLICATE`). */
  async insert(tx: TenantTx, input: NewDossier): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.dossier (tenant_id, id, dossier_code, year, title, organization_unit_id, subject_module, subject_id, category_code, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::int, $3, $4::uuid, $5, $6::uuid, $7, $8::uuid, $8::uuid)
       on conflict (tenant_id, dossier_code, year) do nothing
       returning id`,
      [input.dossierCode, input.year, input.title, input.organizationUnitId, input.subjectModule ?? null, input.subjectId ?? null, input.categoryCode, input.actor],
    );
    if (row === undefined) throw new DomainError('DOSSIER_CODE_DUPLICATE', 409, 'dossier_code');
    return row;
  }

  /** The documents of a dossier in the order of the contents. */
  async items(tx: TenantTx, dossierId: string): Promise<DossierItemRecord[]> {
    const rows = await tx.query<{ id: string; document_id: string; ordinal: number; title: string; doc_kind: string; doc_type_code: string; classification: string; issued_on: string | null; added_at: string }>(
      `select i.id, i.document_id, i.ordinal, d.title, d.doc_kind, d.doc_type_code, d.classification, d.issued_on::text as issued_on, ${TIMESTAMP('i.added_at')} as added_at
         from machvon.dossier_item i join machvon.document d on d.tenant_id = i.tenant_id and d.id = i.document_id
        where i.dossier_id = $1::uuid order by i.ordinal`,
      [dossierId],
    );
    return rows.map((row) => ({ id: row.id, documentId: row.document_id, ordinal: row.ordinal, title: row.title, docKind: row.doc_kind, docTypeCode: row.doc_type_code, classification: row.classification, issuedOn: row.issued_on, addedAt: row.added_at }));
  }

  /** The day the last document of the dossier was issued (an incoming letter: the day written on it), for a rule that counts from it. */
  async latestIssuedOn(tx: TenantTx, dossierId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ latest: string | null }>(
      `select max(coalesce(d.issued_on, n.original_issued_on))::text as latest
         from machvon.dossier_item i
         join machvon.document d on d.tenant_id = i.tenant_id and d.id = i.document_id
         left join machvon.incoming_document n on n.tenant_id = d.tenant_id and n.document_id = d.id
        where i.dossier_id = $1::uuid`,
      [dossierId],
    );
    return row?.latest ?? undefined;
  }

  /** A document as filing sees it, with the unit of its issuer and its state in the chain of its own kind. */
  async fileable(tx: TenantTx, documentId: string): Promise<FileableDocument | undefined> {
    const [row] = await tx.query<{ id: string; doc_kind: string; title: string; issuer_unit_id: string | null; issuer_unit_path: string | null; outgoing_status: string | null; incoming_id: string | null; incoming_status: string | null }>(
      `select d.id, d.doc_kind, d.title, d.issuer_unit_id, u.path as issuer_unit_path, o.status as outgoing_status, i.id as incoming_id, i.status as incoming_status
         from machvon.document d
         left join machvon.organization_unit u on u.tenant_id = d.tenant_id and u.id = d.issuer_unit_id
         left join machvon.outgoing_document o on o.tenant_id = d.tenant_id and o.document_id = d.id
         left join machvon.incoming_document i on i.tenant_id = d.tenant_id and i.document_id = d.id
        where d.id = $1::uuid`,
      [documentId],
    );
    return row === undefined
      ? undefined
      : { id: row.id, docKind: row.doc_kind, title: row.title, issuerUnitId: row.issuer_unit_id, issuerUnitPath: row.issuer_unit_path, outgoingStatus: row.outgoing_status, incomingId: row.incoming_id, incomingStatus: row.incoming_status };
  }

  /** The dossier a document is in, if any: a document is in one dossier only. */
  async dossierOf(tx: TenantTx, documentId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ dossier_id: string }>('select dossier_id from machvon.dossier_item where document_id = $1::uuid limit 1', [documentId]);
    return row?.dossier_id;
  }

  /**
   * Puts a document into an open dossier at the next place of the contents, or at the place asked for (422 `ordinal` when it is taken), and takes the dossier to its next version. A document is in one dossier only
   * (422 `DOCUMENT_ALREADY_IN_DOSSIER`), also when two dossiers are asked at once.
   */
  async addItem(tx: TenantTx, dossier: DossierRecord, input: { documentId: string; ordinal: number | undefined; actor: string }): Promise<{ id: string; ordinal: number }> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('doc.dossier.item:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [input.documentId]);
    if ((await this.dossierOf(tx, input.documentId)) !== undefined) throw new DomainError('DOCUMENT_ALREADY_IN_DOSSIER', 422, 'document_id');
    const [next] = await tx.query<{ next: number }>('select coalesce(max(ordinal), 0) + 1 as next from machvon.dossier_item where dossier_id = $1::uuid', [dossier.id]);
    const ordinal = input.ordinal ?? (next as { next: number }).next;
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.dossier_item (tenant_id, id, dossier_id, document_id, ordinal, added_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::int, $4::uuid)
       on conflict do nothing returning id`,
      [dossier.id, input.documentId, ordinal, input.actor],
    );
    if (row === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'ordinal');
    await tx.query('update machvon.dossier set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [dossier.id, input.actor]);
    return { id: row.id, ordinal };
  }

  /** Closes an open dossier with what the retention rule gave. */
  async close(tx: TenantTx, dossier: DossierRecord, input: { closedAt: Date; ruleId: string | null; classCode: RetentionClass; provisional: boolean; endsOn: string | null; handoverDueOn: string | null; settlementClosedOn: string | undefined; actor: string }): Promise<void> {
    await tx.query(
      `update machvon.dossier
          set status = 'CLOSED', closed_at = $2::timestamptz, closed_by = $9::uuid, retention_rule_id = $3::uuid, retention_class_code = $4, provisional_retention = $5, retention_ends_on = $6::date, handover_due_on = $7::date,
              settlement_closed_on = $8::date, updated_at = now(), updated_by = $9::uuid, version = version + 1
        where id = $1::uuid`,
      [dossier.id, input.closedAt.toISOString(), input.ruleId, input.classCode, input.provisional, input.endsOn, input.handoverDueOn, input.settlementClosedOn ?? null, input.actor],
    );
  }

  /**
   * The dossier goes to the archive: CLOSED to HANDED_OVER and, in the same step, ARCHIVED (the archive has it), with the reference the archive gave, the moment of the handover and who made it. The outgoing documents that
   * were filed in it are ARCHIVED with it, each with a line in its timeline; documents that are not FILED any more (recalled, say) are left as they are. Returns the documents archived.
   */
  async handover(tx: TenantTx, dossier: DossierRecord, input: { archiveRef: string; handedOverAt: Date; actor: string }): Promise<number> {
    await tx.query(
      `update machvon.dossier set status = 'HANDED_OVER', handed_over_at = $2::timestamptz, archive_ref = $3, handed_over_by = $4::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [dossier.id, input.handedOverAt.toISOString(), input.archiveRef, input.actor],
    );
    await tx.query("update machvon.dossier set status = 'ARCHIVED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [dossier.id, input.actor]);
    const archived = await tx.query<{ id: string; version: string }>(
      `with held as (
         select o.id from machvon.outgoing_document o join machvon.dossier_item i on i.tenant_id = o.tenant_id and i.document_id = o.document_id where i.dossier_id = $1::uuid and o.status = 'FILED' for update of o)
       update machvon.outgoing_document o set status = 'ARCHIVED', updated_at = now(), updated_by = $2::uuid, version = o.version + 1 from held where o.id = held.id returning o.id, o.version::text as version`,
      [dossier.id, input.actor],
    );
    for (const row of archived) {
      await tx.query(
        `insert into machvon.outgoing_document_event (tenant_id, id, outgoing_document_id, kind, from_status, to_status, actor_id, details, document_version, occurred_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'ARCHIVED', 'FILED', 'ARCHIVED', $2::uuid, $3::jsonb, $4::bigint, $5::timestamptz)`,
        [row.id, input.actor, JSON.stringify({ dossier_id: dossier.id, archive_ref: input.archiveRef }), row.version, input.handedOverAt.toISOString()],
      );
    }
    return archived.length;
  }

  /** A disposal is proposed: the dossier waits for the decision of the council, and who proposed it, why and from which state are kept. */
  async proposeDisposal(tx: TenantTx, dossier: DossierRecord, input: { reason: string; at: Date; actor: string }): Promise<void> {
    await tx.query(
      `update machvon.dossier set status = 'DISPOSAL_PROPOSED', disposal_proposed_by = $2::uuid, disposal_proposed_at = $3::timestamptz, disposal_reason = $4, disposal_from_status = $5,
              updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [dossier.id, input.actor, input.at.toISOString(), input.reason, dossier.status],
    );
  }

  /**
   * The decision of the council. Approved, the dossier is DISPOSED with the document of the decision (no content is deleted here: the tenant's archive process is told); rejected, it goes back to the state it was
   * proposed from and the proposal is cleared (the audit row keeps who proposed, who decided and what they wrote).
   */
  async decideDisposal(tx: TenantTx, dossier: DossierRecord, input: { approve: boolean; councilDecisionDocumentId: string | undefined; comment: string | undefined; at: Date; actor: string }): Promise<void> {
    if (input.approve) {
      await tx.query(
        `update machvon.dossier set status = 'DISPOSED', disposal_decided_by = $2::uuid, disposal_decided_at = $3::timestamptz, disposal_decision_document_id = $4::uuid, disposal_comment = $5,
                updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [dossier.id, input.actor, input.at.toISOString(), input.councilDecisionDocumentId ?? null, input.comment ?? null],
      );
      return;
    }
    await tx.query(
      `update machvon.dossier set status = disposal_from_status, disposal_proposed_by = null, disposal_proposed_at = null, disposal_reason = null, disposal_from_status = null,
              updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [dossier.id, input.actor],
    );
  }

  /**
   * The outgoing document of a filed document goes to FILED and the step is written in its timeline (who, when, which dossier); one that is not issued any more (recalled meanwhile) is left as it is and the answer is false,
   * so that the caller can refuse the filing.
   */
  async markOutgoingFiled(tx: TenantTx, documentId: string, input: { actor: string; dossierId: string; ordinal: number; at: Date }): Promise<boolean> {
    const moved = await tx.query<{ id: string; from_status: string; version: string }>(
      `with held as (select id, status from machvon.outgoing_document where document_id = $1::uuid and status in ('ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'CORRECTED') for update)
       update machvon.outgoing_document o set status = case when held.status = 'CORRECTED' then 'CORRECTED' else 'FILED' end, updated_at = now(), updated_by = $2::uuid, version = o.version + 1
         from held where o.id = held.id
       returning o.id, held.status as from_status, o.version::text as version`,
      [documentId, input.actor],
    );
    const row = moved[0];
    if (row === undefined) return false;
    await tx.query(
      `insert into machvon.outgoing_document_event (tenant_id, id, outgoing_document_id, kind, from_status, to_status, actor_id, details, document_version, occurred_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'FILED', $2, $7, $3::uuid, $4::jsonb, $5::bigint, $6::timestamptz)`,
      [row.id, row.from_status, input.actor, JSON.stringify({ dossier_id: input.dossierId, ordinal: input.ordinal }), row.version, input.at.toISOString(), row.from_status === 'CORRECTED' ? 'CORRECTED' : 'FILED'],
    );
    return true;
  }

  /** The retention rules, by category and then by id (the whole catalogue of the tenant is small). */
  async listRules(tx: TenantTx, filters: RuleFilters, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<{ records: RetentionRuleRecord[]; next: { code: string; id: string } | undefined }> {
    const rows = await tx.query<RuleRow>(
      `select ${RULE_COLUMNS} from machvon.doc_retention_rule
        where ($1::text is null or rule_set = $1) and ($2::text is null or category_code = $2) and ($3::text is null or (category_code, id) > ($3::text, $4::uuid))
        order by category_code, id limit $5::int`,
      [filters.ruleSet ?? null, filters.categoryCode ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toRule), next: rows.length > page.limit && last !== undefined ? { code: last.category_code, id: last.id } : undefined };
  }

  /** The published rules of a category, to choose from when a dossier is closed. */
  async publishedRules(tx: TenantTx, categoryCode: string): Promise<RetentionRuleView[]> {
    const rows = await tx.query<RuleRow>(`select ${RULE_COLUMNS} from machvon.doc_retention_rule where category_code = $1 and status = 'PUBLISHED'`, [categoryCode]);
    return rows.map(toRule);
  }

  /** A dossier whose handover is due within thirty days and for which a reminder of this stage was not sent yet; the stage is the nearest of 30, 7 and 1 days (a day that has passed is the last). */
  async dueForHandoverReminder(tx: TenantTx, today: string): Promise<Array<{ record: DossierRecord; daysLeft: number; stage: HandoverReminderStage }>> {
    const rows = await tx.query<Row & { days_left: string }>(
      `select ${COLUMNS}, (d.handover_due_on - $1::date)::text as days_left from ${FROM}
        where d.status = 'CLOSED' and d.handover_due_on is not null and (d.handover_due_on - $1::date) <= 30
          and (d.handover_reminded_days is null or d.handover_reminded_days > case when (d.handover_due_on - $1::date) <= 1 then 1 when (d.handover_due_on - $1::date) <= 7 then 7 else 30 end)
        order by d.handover_due_on, d.id for update of d`,
      [today],
    );
    return rows.map((row) => {
      const daysLeft = Number(row.days_left);
      return { record: toRecord(row), daysLeft, stage: daysLeft <= 1 ? 1 : daysLeft <= 7 ? 7 : 30 };
    });
  }

  /** The stage of the reminder that was sent; the version of the dossier does not move, since nothing a person reads or changes did. */
  async markHandoverReminded(tx: TenantTx, dossierId: string, stage: HandoverReminderStage): Promise<void> {
    await tx.query('update machvon.dossier set handover_reminded_days = $2::smallint where id = $1::uuid', [dossierId, stage]);
  }

  /**
   * Which of the dossiers an Active legal hold contains (BR-DOC-23): the platform's own answer (`legal_hold_blocks`) for the dossier itself (the whole tenant, a unit above its own, the project or contract it is about, or the
   * dossier named as a resource), and a hold that names a document filed in it, which stops its disposal as well. One query for any number of dossiers.
   */
  async holdsActive(tx: TenantTx, dossierIds: readonly string[]): Promise<Set<string>> {
    if (dossierIds.length === 0) return new Set();
    const rows = await tx.query<{ id: string; held: boolean }>(
      `select d.id, (machvon.legal_hold_blocks('dossier', d.id)
                or exists (select 1 from machvon.dossier_item i
                            where i.tenant_id = d.tenant_id and i.dossier_id = d.id
                              and exists (select 1 from machvon.legal_hold h where h.status = 'Active' and h.effective_at <= now() and h.resource_scope -> 'ids' ? i.document_id::text))) as held
         from machvon.dossier d where d.id = any($1::uuid[])`,
      [dossierIds],
    );
    return new Set(rows.filter((row) => row.held).map((row) => row.id));
  }

  /** The active memberships of the tenant. */
  async activeMemberships(tx: TenantTx): Promise<string[]> {
    const rows = await tx.query<{ membership_id: string }>("select membership_id from machvon.tenant_user_directory where status = 'Active' order by membership_id");
    return rows.map((row) => row.membership_id);
  }

  /** The document of a decision of the council: a document the tenant issued (not a draft, not recalled or replaced) or received; one that does not exist in the tenant is none. */
  async decisionDocumentUsable(tx: TenantTx, documentId: string): Promise<boolean> {
    const rows = await tx.query(
      `select 1 from machvon.document d
         left join machvon.outgoing_document o on o.tenant_id = d.tenant_id and o.document_id = d.id
        where d.id = $1::uuid and (d.doc_kind = 'INCOMING' or o.status in ('ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED', 'CORRECTED'))`,
      [documentId],
    );
    return rows.length > 0;
  }

  /** Whether an Active legal hold contains the dossier or a document filed in it (see {@link holdsActive}). */
  async holdActive(tx: TenantTx, dossierId: string): Promise<boolean> {
    return (await this.holdsActive(tx, [dossierId])).has(dossierId);
  }
}
