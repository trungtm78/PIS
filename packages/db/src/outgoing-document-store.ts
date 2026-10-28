import { DomainError, versionConflict } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type OutgoingStatus =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'SUBMITTED'
  | 'SIGNED'
  | 'NUMBERED'
  | 'SEALED'
  | 'ISSUED'
  | 'DELIVERED'
  | 'ACKNOWLEDGED'
  | 'FILED'
  | 'ARCHIVED'
  | 'CANCELLED'
  | 'RECALLED'
  | 'REPLACED'
  | 'CORRECTED';

export type SigningRole = 'LEADER' | 'ORGANIZATION';
export type AdapterCode = 'REMOTE_CA' | 'LOCAL_AGENT' | 'MOCK';
export type AdapterStatus = 'VERIFIED' | 'PROPOSED' | 'MOCK' | 'MISSING';
export type SessionStatus = 'CREATED' | 'HASH_READY' | 'AWAITING_SIGNER' | 'SIGNED' | 'EMBEDDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

/** An outgoing document with the columns of its document anchor that the screens show. */
export interface OutgoingDocumentRecord {
  id: string;
  documentId: string;
  status: OutgoingStatus;
  route: 'IN_SYSTEM' | 'EXTERNAL_UPLOAD';
  urgency: string;
  circulation: string;
  draftingUnitId: string;
  drafterUserId: string;
  signerUserId: string | null;
  signerTitle: string | null;
  signingMode: string;
  delegationId: string | null;
  clerkUserId: string | null;
  registerId: string | null;
  allocationId: string | null;
  recipients: unknown;
  leaderSignedAt: Date | null;
  numberedAt: Date | null;
  sealedAt: Date | null;
  issuedAt: Date | null;
  version: number;
  title: string;
  docTypeCode: string;
  currentVersionId: string | null;
  documentNumber: number | null;
  numberYear: number | null;
  symbol: string | null;
  issuedOn: string | null;
  createdAt: Date;
  /** Microsecond text of `createdAt`: the ordering key of the keyset cursor. */
  sortKey: string;
  templateId: string | null;
  /** The effect of the document anchor: PENDING until it is issued, EXPIRED when the draft was cancelled. */
  effectStatus: string;
  classification: string;
  sourceModule: string | null;
  sourceRef: string | null;
  issueRequestId: string | null;
  payloadSha256: string | null;
  reviewDueOn: string | null;
  cancelReason: string | null;
  /** Why an issued document was recalled, when, and by whom (ST-DOC-012). */
  recallReason: string | null;
  recalledAt: Date | null;
  recalledBy: string | null;
  /** The written reason a document with an unconfirmed template was issued anyway (BR-DOC-10), and who wrote it. */
  unconfirmedOverrideReason: string | null;
  unconfirmedOverrideBy: string | null;
}

export interface SigningSessionRecord {
  id: string;
  outgoingDocumentId: string;
  role: SigningRole;
  signerUserId: string | null;
  signingCertificateId: string | null;
  adapterCode: AdapterCode;
  adapterStatus: AdapterStatus;
  status: SessionStatus;
  baseVersionId: string;
  resultVersionId: string | null;
  digestHex: string | null;
  byteRange: [number, number, number, number] | null;
  providerTxnRef: string | null;
  expiresAt: Date;
  attempts: number;
  errorCode: string | null;
  createdAt: Date;
  createdBy: string;
  version: number;
}

export interface NewSigningSession {
  /** The id of the session; the prepared file is stored under it before the row exists. */
  id: string;
  outgoingDocumentId: string;
  role: SigningRole;
  signerUserId: string;
  signingCertificateId: string;
  adapterCode: AdapterCode;
  adapterStatus: AdapterStatus;
  baseVersionId: string;
  digestHex: string;
  byteRange: [number, number, number, number];
  providerTxnRef: string;
  expiresAt: Date;
  actor: string;
}

export interface OutgoingFilters {
  status?: OutgoingStatus | undefined;
  docTypeCode?: string | undefined;
  draftingUnitId?: string | undefined;
  year?: number | undefined;
}

export interface OutgoingPage {
  limit: number;
  after?: { sortKey: string; id: string } | undefined;
}

interface OutgoingRow {
  id: string;
  document_id: string;
  status: OutgoingStatus;
  route: 'IN_SYSTEM' | 'EXTERNAL_UPLOAD';
  urgency: string;
  circulation: string;
  drafting_unit_id: string;
  drafter_user_id: string;
  signer_user_id: string | null;
  signer_title: string | null;
  signing_mode: string;
  delegation_id: string | null;
  clerk_user_id: string | null;
  register_id: string | null;
  allocation_id: string | null;
  recipients: unknown;
  leader_signed_at: Date | null;
  numbered_at: Date | null;
  sealed_at: Date | null;
  issued_at: Date | null;
  version: string;
  title: string;
  doc_type_code: string;
  current_version_id: string | null;
  document_number: number | null;
  number_year: number | null;
  symbol: string | null;
  issued_on: string | null;
  created_at: Date;
  sort_key: string;
  template_id: string | null;
  effect_status: string;
  classification: string;
  source_module: string | null;
  source_ref: string | null;
  issue_request_id: string | null;
  payload_sha256: string | null;
  review_due_on: string | null;
  cancel_reason: string | null;
  recall_reason: string | null;
  recalled_at: Date | null;
  recalled_by: string | null;
  unconfirmed_override_reason: string | null;
  unconfirmed_override_by: string | null;
}

interface SessionRow {
  id: string;
  outgoing_document_id: string;
  role: SigningRole;
  signer_user_id: string | null;
  signing_certificate_id: string | null;
  adapter_code: AdapterCode;
  adapter_status: AdapterStatus;
  status: SessionStatus;
  base_version_id: string;
  result_version_id: string | null;
  digest_hex: string | null;
  byte_range: [number, number, number, number] | null;
  provider_txn_ref: string | null;
  expires_at: Date;
  attempts: number;
  error_code: string | null;
  created_at: Date;
  created_by: string;
  version: string;
}

const OUTGOING_COLUMNS = `o.id, o.document_id, o.status, o.route, o.urgency, o.circulation, o.drafting_unit_id, o.drafter_user_id, o.signer_user_id,
  o.signer_title, o.signing_mode, o.delegation_id, o.clerk_user_id, o.register_id, o.allocation_id, o.recipients, o.leader_signed_at, o.numbered_at,
  o.sealed_at, o.issued_at, o.version::text as version, d.title, d.doc_type_code, d.current_version_id, d.document_number, d.number_year, d.symbol,
  d.issued_on::text as issued_on, o.created_at, ${timestampKey('o.created_at')} as sort_key, o.template_id, d.effect_status, d.classification,
  o.source_module, o.source_ref, o.issue_request_id, o.payload_sha256, o.review_due_on::text as review_due_on, o.cancel_reason,
  o.recall_reason, o.recalled_at, o.recalled_by, o.unconfirmed_override_reason, o.unconfirmed_override_by`;
const OUTGOING_FROM = `from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id`;
const SESSION_COLUMNS = `s.id, s.outgoing_document_id, s.role, s.signer_user_id, s.signing_certificate_id, s.adapter_code, s.adapter_status, s.status,
  s.base_version_id, s.result_version_id, s.digest_hex, s.byte_range, s.provider_txn_ref, s.expires_at, s.attempts, s.error_code, s.created_at,
  s.created_by, s.version::text as version`;
const OPEN_STATUSES = ['CREATED', 'HASH_READY', 'AWAITING_SIGNER', 'SIGNED'];

/** A registered certificate as a signing screen lists it: public data only. */
export interface SigningCertificateOption {
  id: string;
  kind: 'PERSONAL' | 'ORGANIZATION';
  holderMembershipId: string | null;
  organizationUnitId: string | null;
  subjectDn: string;
  issuerDn: string;
  validFrom: Date;
  validUntil: Date;
  fingerprintSha256: string;
  status: string;
}

export interface DocumentVersionSummary {
  id: string;
  version: number;
  stage: string;
  checksum: string;
  byteLength: number | null;
  pageCount: number;
  scanStatus: string;
  prefixSha256: string | null;
  createdAt: Date;
}

/** The sealed file of an issued document whose revocation status is due to be asked again. */
export interface RevocationDue {
  outgoingDocumentId: string;
  documentId: string;
  versionId: string;
  objectKey: string;
  checksum: string;
}

/** The columns of the drafting unit that scope predicates for outgoing documents are compiled against. */
export const OUTGOING_SCOPE_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;
// An outgoing document is in scope when its drafting unit is.
const IN_SCOPE = (predicate: string): string => `o.drafting_unit_id in (select ou.id from machvon.organization_unit ou where ${predicate})`;

function toOutgoing(row: OutgoingRow): OutgoingDocumentRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    status: row.status,
    route: row.route,
    urgency: row.urgency,
    circulation: row.circulation,
    draftingUnitId: row.drafting_unit_id,
    drafterUserId: row.drafter_user_id,
    signerUserId: row.signer_user_id,
    signerTitle: row.signer_title,
    signingMode: row.signing_mode,
    delegationId: row.delegation_id,
    clerkUserId: row.clerk_user_id,
    registerId: row.register_id,
    allocationId: row.allocation_id,
    recipients: row.recipients,
    leaderSignedAt: row.leader_signed_at,
    numberedAt: row.numbered_at,
    sealedAt: row.sealed_at,
    issuedAt: row.issued_at,
    version: Number(row.version),
    title: row.title,
    docTypeCode: row.doc_type_code,
    currentVersionId: row.current_version_id,
    documentNumber: row.document_number,
    numberYear: row.number_year,
    symbol: row.symbol,
    issuedOn: row.issued_on,
    createdAt: row.created_at,
    sortKey: row.sort_key,
    templateId: row.template_id,
    effectStatus: row.effect_status,
    classification: row.classification,
    sourceModule: row.source_module,
    sourceRef: row.source_ref,
    issueRequestId: row.issue_request_id,
    payloadSha256: row.payload_sha256,
    reviewDueOn: row.review_due_on,
    cancelReason: row.cancel_reason,
    recallReason: row.recall_reason,
    recalledAt: row.recalled_at,
    recalledBy: row.recalled_by,
    unconfirmedOverrideReason: row.unconfirmed_override_reason,
    unconfirmedOverrideBy: row.unconfirmed_override_by,
  };
}

function toSession(row: SessionRow): SigningSessionRecord {
  return {
    id: row.id,
    outgoingDocumentId: row.outgoing_document_id,
    role: row.role,
    signerUserId: row.signer_user_id,
    signingCertificateId: row.signing_certificate_id,
    adapterCode: row.adapter_code,
    adapterStatus: row.adapter_status,
    status: row.status,
    baseVersionId: row.base_version_id,
    resultVersionId: row.result_version_id,
    digestHex: row.digest_hex,
    byteRange: row.byte_range,
    providerTxnRef: row.provider_txn_ref,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: Number(row.version),
  };
}

function notFound(): DomainError {
  return new DomainError('RESOURCE_NOT_FOUND', 404);
}

/**
 * Outgoing documents and their signing sessions (ST-DOC-005, DOC.md F4 and F6). Every query runs inside the caller's
 * tenant transaction. The state moves forward only: the guards of V017 refuse a session or a document that goes back.
 */
export class OutgoingDocumentStore {
  /** One outgoing document; `scope` (compiled over `OUTGOING_SCOPE_COLUMNS`) narrows it to what the caller may see. */
  async find(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<OutgoingDocumentRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<OutgoingRow>(
      `select ${OUTGOING_COLUMNS} ${OUTGOING_FROM} where o.id = $1::uuid and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}`,
      [id, ...(predicate?.params ?? [])],
    );
    return row === undefined ? undefined : toOutgoing(row);
  }

  /** The outgoing document that belongs to a document anchor, inside the scope. */
  async findByDocument(tx: TenantTx, documentId: string, scope?: ScopeBuilder): Promise<OutgoingDocumentRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<OutgoingRow>(
      `select ${OUTGOING_COLUMNS} ${OUTGOING_FROM} where o.document_id = $1::uuid and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}`,
      [documentId, ...(predicate?.params ?? [])],
    );
    return row === undefined ? undefined : toOutgoing(row);
  }

  /** Like `find`, with the row locked until the end of the transaction: commands on one document run one after another. */
  async lock(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<OutgoingDocumentRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<OutgoingRow>(
      `select ${OUTGOING_COLUMNS} ${OUTGOING_FROM} where o.id = $1::uuid and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)} for update of o`,
      [id, ...(predicate?.params ?? [])],
    );
    return row === undefined ? undefined : toOutgoing(row);
  }

  /** Newest first, in keyset pages of the creation time and the id. */
  async list(tx: TenantTx, filters: OutgoingFilters, page: OutgoingPage, scope?: ScopeBuilder): Promise<OutgoingDocumentRecord[]> {
    assertTimestampCursor(page.after?.sortKey);
    const predicate = scope?.(8);
    const rows = await tx.query<OutgoingRow>(
      `select ${OUTGOING_COLUMNS} ${OUTGOING_FROM}
        where ($1::text is null or o.status = $1) and ($2::text is null or d.doc_type_code = $2) and ($3::uuid is null or o.drafting_unit_id = $3::uuid)
          and ($4::int is null or extract(year from o.created_at at time zone 'Asia/Ho_Chi_Minh') = $4)
          and ($5::text is null or (o.created_at, o.id) < ($5::timestamptz, $6::uuid)) and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}
        order by o.created_at desc, o.id desc limit $7`,
      [filters.status ?? null, filters.docTypeCode ?? null, filters.draftingUnitId ?? null, filters.year ?? null, page.after?.sortKey ?? null, page.after?.id ?? null, page.limit, ...(predicate?.params ?? [])],
    );
    return rows.map(toOutgoing);
  }

  /** The file versions of a document, newest first: the history the signing screens show next to the viewer. */
  async versionsOf(tx: TenantTx, documentId: string): Promise<DocumentVersionSummary[]> {
    const rows = await tx.query<{
      id: string;
      version: number;
      stage: string;
      checksum: string;
      byte_length: string | null;
      page_count: number;
      scan_status: string;
      prefix_sha256: string | null;
      created_at: Date;
    }>(
      `select id, version, stage, checksum, byte_length::text as byte_length, page_count, scan_status, prefix_sha256, created_at
         from machvon.document_version where document_id = $1::uuid order by version desc`,
      [documentId],
    );
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      stage: row.stage,
      checksum: row.checksum,
      byteLength: row.byte_length === null ? null : Number(row.byte_length),
      pageCount: row.page_count,
      scanStatus: row.scan_status,
      prefixSha256: row.prefix_sha256,
      createdAt: row.created_at,
    }));
  }

  /**
   * The certificates a document may be signed with: the personal certificates of the signer and the organisation
   * certificates of the drafting unit and of the units above it. The status is the stored one with the clock applied.
   */
  async certificatesFor(tx: TenantTx, input: { holderMembershipId: string | null; draftingUnitId: string }): Promise<SigningCertificateOption[]> {
    const rows = await tx.query<{
      id: string;
      kind: 'PERSONAL' | 'ORGANIZATION';
      holder_membership_id: string | null;
      organization_unit_id: string | null;
      subject_dn: string;
      issuer_dn: string;
      valid_from: Date;
      valid_until: Date;
      fingerprint_sha256: string;
      status: string;
    }>(
      `select c.id, c.kind, c.holder_membership_id, c.organization_unit_id, c.subject_dn, c.issuer_dn, c.valid_from, c.valid_until, c.fingerprint_sha256,
              case when c.status = 'Active' and c.valid_until <= now() then 'Expired' else c.status end as status
         from machvon.signing_certificate c
        where (c.kind = 'PERSONAL' and c.holder_membership_id = $1::uuid)
           or (c.kind = 'ORGANIZATION' and c.organization_unit_id in (
                select up.id from machvon.organization_unit up join machvon.organization_unit own on own.id = $2::uuid and starts_with(own.path, up.path)))
        order by c.kind, c.valid_until desc, c.id`,
      [input.holderMembershipId, input.draftingUnitId],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      holderMembershipId: row.holder_membership_id,
      organizationUnitId: row.organization_unit_id,
      subjectDn: row.subject_dn,
      issuerDn: row.issuer_dn,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      fingerprintSha256: row.fingerprint_sha256,
      status: row.status,
    }));
  }

  async findSession(tx: TenantTx, id: string, options: { lock?: boolean; scope?: ScopeBuilder } = {}): Promise<SigningSessionRecord | undefined> {
    const predicate = options.scope?.(2);
    const [row] = await tx.query<SessionRow>(
      `select ${SESSION_COLUMNS} from machvon.doc_signing_session s join machvon.outgoing_document o on o.tenant_id = s.tenant_id and o.id = s.outgoing_document_id
        where s.id = $1::uuid and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}${options.lock === true ? ' for update of s' : ''}`,
      [id, ...(predicate?.params ?? [])],
    );
    return row === undefined ? undefined : toSession(row);
  }

  /** The sessions of a document, newest first: the history DOC-05 shows. */
  async sessionsOf(tx: TenantTx, outgoingDocumentId: string): Promise<SigningSessionRecord[]> {
    const rows = await tx.query<SessionRow>(
      `select ${SESSION_COLUMNS} from machvon.doc_signing_session s where s.outgoing_document_id = $1::uuid order by s.created_at desc, s.id desc`,
      [outgoingDocumentId],
    );
    return rows.map(toSession);
  }

  /** The session of the role that is still open, if any (at most one: the unique index of V002 says so). */
  async openSession(tx: TenantTx, outgoingDocumentId: string, role: SigningRole): Promise<SigningSessionRecord | undefined> {
    const [row] = await tx.query<SessionRow>(
      `select ${SESSION_COLUMNS} from machvon.doc_signing_session s where s.outgoing_document_id = $1::uuid and s.role = $2 and s.status = any($3::text[])`,
      [outgoingDocumentId, role, OPEN_STATUSES],
    );
    return row === undefined ? undefined : toSession(row);
  }

  /** Closes the open sessions of the role whose time has run out, so a new one can start; returns them. */
  async expireDue(tx: TenantTx, outgoingDocumentId: string, role: SigningRole, now: Date, actor: string): Promise<SigningSessionRecord[]> {
    const rows = await tx.query<SessionRow>(
      `update machvon.doc_signing_session as s set status = 'EXPIRED', error_code = 'SIGNING_SESSION_EXPIRED', updated_at = now(), updated_by = $5::uuid, version = s.version + 1
        where s.outgoing_document_id = $1::uuid and s.role = $2 and s.status = any($3::text[]) and s.expires_at <= $4::timestamptz
        returning ${SESSION_COLUMNS}`,
      [outgoingDocumentId, role, OPEN_STATUSES, now.toISOString(), actor],
    );
    return rows.map(toSession);
  }

  async createSession(tx: TenantTx, input: NewSigningSession): Promise<SigningSessionRecord> {
    const [row] = await tx.query<SessionRow>(
      `insert into machvon.doc_signing_session as s
         (tenant_id, id, outgoing_document_id, role, signer_user_id, signing_certificate_id, adapter_code, adapter_status, status, base_version_id,
          digest_hex, byte_range, provider_txn_ref, expires_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $13::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, 'AWAITING_SIGNER', $7::uuid,
          $8, $9::jsonb, $10, $11::timestamptz, $12::uuid, $12::uuid)
       returning ${SESSION_COLUMNS}`,
      [
        input.outgoingDocumentId,
        input.role,
        input.signerUserId,
        input.signingCertificateId,
        input.adapterCode,
        input.adapterStatus,
        input.baseVersionId,
        input.digestHex,
        JSON.stringify(input.byteRange),
        input.providerTxnRef,
        input.expiresAt.toISOString(),
        input.actor,
        input.id,
      ],
    );
    if (row === undefined) throw new Error('signing session insert returned no row');
    return toSession(row);
  }

  /** Counts one attempt to collect the signature; the session keeps waiting. */
  async recordAttempt(tx: TenantTx, id: string, actor: string): Promise<void> {
    await tx.query('update machvon.doc_signing_session set attempts = attempts + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid', [id, actor]);
  }

  /** The signature is in the file: the session ends EMBEDDED and points at the version that carries it. */
  async completeSession(tx: TenantTx, id: string, input: { resultVersionId: string; actor: string }): Promise<SigningSessionRecord> {
    const [row] = await tx.query<SessionRow>(
      `update machvon.doc_signing_session as s set status = 'EMBEDDED', result_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = s.version + 1
        where s.id = $1::uuid and s.status in ('CREATED', 'HASH_READY', 'AWAITING_SIGNER') returning ${SESSION_COLUMNS}`,
      [id, input.resultVersionId, input.actor],
    );
    if (row === undefined) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'session');
    return toSession(row);
  }

  /** The leader signed: SUBMITTED to SIGNED. A stale version is 409 VERSION_CONFLICT, another status 409 DOCUMENT_STATE_INVALID. */
  async markSigned(tx: TenantTx, id: string, input: { expectedVersion: number; signedAt: Date; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.advance(tx, id, input.expectedVersion, 'SUBMITTED', 'status = \'SIGNED\', leader_signed_at = $3::timestamptz', [input.signedAt.toISOString()], input.actor);
  }

  /** The leader signature came from outside the system: SUBMITTED to SIGNED, and the route of the document is the external one (DOC.md F5). */
  async markSignedExternally(tx: TenantTx, id: string, input: { expectedVersion: number; signedAt: Date; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.advance(tx, id, input.expectedVersion, 'SUBMITTED', "status = 'SIGNED', route = 'EXTERNAL_UPLOAD', leader_signed_at = $3::timestamptz", [input.signedAt.toISOString()], input.actor);
  }

  /**
   * A document that was signed and numbered in another system enters DOC already issued (DOC.md F5 b): the row carries the number it was given, the two
   * instants of its signatures and the register; the database checks of an issued document (allocation, issue and seal instants) hold.
   */
  async insertIssuedExternally(
    tx: TenantTx,
    input: {
      documentId: string;
      layoutProfileId: string;
      draftingUnitId: string;
      registerId: string;
      allocationId: string;
      recipients: readonly unknown[];
      leaderSignedAt: Date;
      sealedAt: Date;
      issuedAt: Date;
      actor: string;
    },
  ): Promise<OutgoingDocumentRecord> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.outgoing_document
         (tenant_id, id, document_id, layout_profile_id, status, route, drafting_unit_id, drafter_user_id, clerk_user_id, register_id, allocation_id, recipients,
          leader_signed_at, numbered_at, sealed_at, issued_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'ISSUED', 'EXTERNAL_UPLOAD', $3::uuid, $4::uuid, $4::uuid, $5::uuid, $6::uuid, $7::jsonb,
          $8::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $4::uuid, $4::uuid)
       returning id`,
      [input.documentId, input.layoutProfileId, input.draftingUnitId, input.actor, input.registerId, input.allocationId, JSON.stringify(input.recipients), input.leaderSignedAt.toISOString(), input.sealedAt.toISOString(), input.issuedAt.toISOString()],
    );
    if (row === undefined) throw new Error('external outgoing document insert returned no row');
    await tx.query("update machvon.document set effect_status = 'EFFECTIVE', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [input.documentId, input.actor]);
    const found = await this.find(tx, row.id);
    if (found === undefined) throw new Error('outgoing document vanished while it was written');
    return found;
  }

  /** The number is assigned: SIGNED to NUMBERED, with the register, the allocation and the clerk. */
  async markNumbered(
    tx: TenantTx,
    id: string,
    input: { expectedVersion: number; registerId: string; allocationId: string; numberedAt: Date; clerk: string },
  ): Promise<OutgoingDocumentRecord> {
    return this.advance(
      tx,
      id,
      input.expectedVersion,
      'SIGNED',
      "status = 'NUMBERED', register_id = $3::uuid, allocation_id = $4::uuid, numbered_at = $5::timestamptz, clerk_user_id = $6::uuid",
      [input.registerId, input.allocationId, input.numberedAt.toISOString(), input.clerk],
      input.clerk,
    );
  }

  /** The organisation seal is in: NUMBERED to SEALED. */
  async markSealed(tx: TenantTx, id: string, input: { expectedVersion: number; sealedAt: Date; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.advance(tx, id, input.expectedVersion, 'NUMBERED', "status = 'SEALED', sealed_at = $3::timestamptz", [input.sealedAt.toISOString()], input.actor);
  }

  /**
   * The document is issued: SEALED to ISSUED, and the document in force (EFFECTIVE). Its number and symbol are on the anchor already (the numbering wrote
   * them), so the checks of the database that ask for both hold.
   */
  async markIssued(
    tx: TenantTx,
    id: string,
    input: { expectedVersion: number; issuedAt: Date; actor: string; override?: { reason: string; by: string } | undefined },
  ): Promise<OutgoingDocumentRecord> {
    const issued =
      input.override === undefined
        ? await this.advance(tx, id, input.expectedVersion, 'SEALED', "status = 'ISSUED', issued_at = $3::timestamptz", [input.issuedAt.toISOString()], input.actor)
        : await this.advance(
            tx,
            id,
            input.expectedVersion,
            'SEALED',
            "status = 'ISSUED', issued_at = $3::timestamptz, unconfirmed_override_reason = $4, unconfirmed_override_by = $5::uuid",
            [input.issuedAt.toISOString(), input.override.reason, input.override.by],
            input.actor,
          );
    await tx.query("update machvon.document set effect_status = 'EFFECTIVE', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [issued.documentId, input.actor]);
    const found = await this.find(tx, id);
    if (found === undefined) throw new Error('outgoing document vanished while it was locked');
    return found;
  }

  /**
   * The sealed files of documents in force whose revocation was never established as good, or not since `checkedBefore`: documents with no verification
   * at all, with a signature whose revocation status is not GOOD in the latest verification, or whose latest verification is older than the cut.
   * Keyset pages over the version id, so a long run does not read the same row twice.
   */
  async issuedFilesDueForRevocationCheck(tx: TenantTx, input: { checkedBefore: Date; afterVersionId?: string | undefined; limit: number }): Promise<RevocationDue[]> {
    const rows = await tx.query<{ outgoing_document_id: string; document_id: string; version_id: string; object_key: string; checksum: string }>(
      `select o.id as outgoing_document_id, o.document_id, v.id as version_id, v.object_key, v.checksum
         from machvon.outgoing_document o
         join machvon.document_version v on v.tenant_id = o.tenant_id and v.document_id = o.document_id and v.stage = 'ORG_SEALED' and v.scan_status = 'CLEAN'
        where o.status in ('ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED') and ($2::uuid is null or v.id > $2::uuid)
          and (not exists (select 1 from machvon.document_signature s where s.document_version_id = v.id)
               or exists (select 1 from machvon.document_signature s
                           where s.document_version_id = v.id
                             and s.verification_no = (select max(verification_no) from machvon.document_signature where document_version_id = v.id)
                             and (s.revocation_status <> 'GOOD' or s.verified_at <= $1::timestamptz)))
        order by v.id limit $3`,
      [input.checkedBefore.toISOString(), input.afterVersionId ?? null, input.limit],
    );
    return rows.map((row) => ({ outgoingDocumentId: row.outgoing_document_id, documentId: row.document_id, versionId: row.version_id, objectKey: row.object_key, checksum: row.checksum }));
  }

  /** At least one recipient has the document: ISSUED to DELIVERED (DOC.md F8). */
  async markDelivered(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.advance(tx, id, input.expectedVersion, 'ISSUED', "status = 'DELIVERED'", [], input.actor);
  }

  /** Every recipient that had to acknowledge has: DELIVERED to ACKNOWLEDGED (DOC.md F8). */
  async markAcknowledged(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.advance(tx, id, input.expectedVersion, 'DELIVERED', "status = 'ACKNOWLEDGED'", [], input.actor);
  }

  private async advance(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    from: OutgoingStatus,
    assignments: string,
    values: readonly unknown[],
    actor: string,
  ): Promise<OutgoingDocumentRecord> {
    const [current] = await tx.query<{ status: OutgoingStatus; version: string }>('select status, version::text as version from machvon.outgoing_document where id = $1::uuid for update', [id]);
    if (current === undefined) throw notFound();
    if (Number(current.version) !== expectedVersion) throw versionConflict(Number(current.version));
    if (current.status !== from) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    // $1 is the id and $2 the actor; the values of the transition follow from $3.
    await tx.query(
      `update machvon.outgoing_document set ${assignments}, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [id, actor, ...values],
    );
    const found = await this.find(tx, id);
    if (found === undefined) throw new Error('outgoing document vanished while it was locked');
    return found;
  }
}
