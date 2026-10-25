import { DomainError, assertFourEyes, canonicalJson, changeRequestNext, sha256Hex, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ChangeRequestAction, ChangeRequestState } from '@machvon/kernel';
import { attributeReferencesTo, entryOfRecord, isRuleType, tenantLookup, validateMasterContent } from './master-types.ts';
import { assertComplete, assertEdgeAllowed, insertEdges, lockSuccessionGraph, proposalOf } from './master-succession.ts';
import type { TenantTx } from './tenant-database.ts';
import type { TypeLookup } from './master-types.ts';

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export type MasterNamespace = 'PLATFORM' | 'TENANT';
export type MasterRecordStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'EFFECTIVE' | 'RETIRED' | 'MERGED';
export type ChangeKind = 'CREATE' | 'UPDATE' | 'RETIRE' | 'MERGE' | 'UNMERGE' | 'RESTRUCTURE' | 'SUCCESSION';
export type ChangeStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'CANCELLED';
export type MasterDecision = 'approve' | 'reject' | 'return';

/** The content of one version of a master record: what a change request proposes and what a version stores. */
export interface MasterContent {
  label: string;
  attributes: Record<string, unknown>;
  parentRecordId: string | null;
  validFrom: string;
  validUntil: string | null;
  legalBasis: string | null;
}

/**
 * A place that refers to master data, counted for the impact preview and the usage list. `byVersion` columns hold the id of a
 * version (the record is found through it); `byRecord` columns hold the id of the record itself. Later slices add their own
 * references here, so the impact of a change always covers every table that uses the entry.
 */
export interface MasterReference {
  /** Stable name shown in the preview, `table.column`. */
  key: string;
  table: string;
  column: string;
  kind: 'byVersion' | 'byRecord';
}

const version = (table: string, column: string): MasterReference => ({ key: `${table}.${column}`, table, column, kind: 'byVersion' });
const record = (table: string, column: string): MasterReference => ({ key: `${table}.${column}`, table, column, kind: 'byRecord' });

/**
 * Every column of the schema that refers to a master record or to one of its versions, from outside the master data tables (the
 * request of a change and the versions of the record itself do not count as use). A test compares this list with the foreign keys of
 * the migrated database, so a column added by a later slice cannot be left out.
 */
export const MASTER_REFERENCES: readonly MasterReference[] = [
  version('project', 'area_master_version_id'),
  version('project', 'sector_master_version_id'),
  version('project', 'project_type_master_version_id'),
  version('project', 'program_master_version_id'),
  version('project_appraisal', 'criteria_set_version_id'),
  version('project_risk', 'category_master_version_id'),
  version('appropriation', 'fund_source_version_id'),
  version('appropriation', 'program_master_version_id'),
  version('allocation_line', 'fund_source_version_id'),
  version('allocation_line', 'program_master_version_id'),
  version('funding_snapshot_line', 'fund_source_version_id'),
  version('period_snapshot_line', 'fund_source_version_id'),
  version('issue_sla_policy', 'category_version_id'),
  version('issue', 'category_version_id'),
  version('reporting_period', 'calendar_version_id'),
  version('land_parcel', 'ward_master_version_id'),
  version('asset_record', 'asset_class_master_version_id'),
  record('contractor', 'master_record_id'),
  record('treasury_transaction', 'treasury_office_record_id'),
  record('master_crosswalk', 'master_record_id'),
  record('master_merge', 'survivor_record_id'),
  record('master_merge', 'merged_record_id'),
  record('master_succession', 'predecessor_record_id'),
  record('master_succession', 'successor_record_id'),
  record('master_record', 'merged_into_id'),
  record('master_record_version', 'parent_id'),
];

export type TypeScope = 'PLATFORM_ONLY' | 'PLATFORM_WITH_TENANT_EXTENSION' | 'TENANT_ONLY';

/** Who may write a master data type, and whether an entry that is retired must name its successor even when nothing uses it. */
export interface TypePolicy {
  masterType: string;
  scope: TypeScope;
  retireRequiresSuccessor: boolean;
  /** `BASELINE`: the policy of the platform in force for every tenant; `TENANT`: a row the control plane wrote for this tenant. */
  source: 'BASELINE' | 'TENANT';
}

export interface TypePolicySummary extends TypePolicy {
  platformRecords: number;
  tenantRecords: number;
}

/**
 * The policy of the platform for the types it publishes or extends (MDM 3.1 F8): the funding sources and the administrative units are
 * the platform's alone, and so are the project groups and stages and the rule data (the law and the process of the platform are not a
 * tenant's to change); the sectors, programmes, project types, areas, decision types and decision authorities are published by the
 * platform and extended by a tenant with child entries; every other type is the tenant's own. A row of `master_type_policy` written by
 * the control plane replaces the baseline.
 */
export const BASELINE_POLICIES: Readonly<Record<string, { scope: TypeScope; retireRequiresSuccessor: boolean }>> = {
  FUND_SOURCE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  ADMIN_UNIT: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  SECTOR: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  PROGRAM: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  PROJECT_TYPE: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  AREA: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  DECISION_TYPE: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  DECISION_AUTHORITY: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  PROJECT_GROUP: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  PROJECT_STAGE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  PROJECT_GROUP_THRESHOLDS: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  NATIONAL_CODE_REQUIRED: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  NATIONAL_CODE_FORMAT: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  APPRAISAL_CRITERIA: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  LND_TIMER: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  BID_PETITION: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  QMS_REGIME: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  AST_WARRANTY: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  PAY_ADVANCE_CAP: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  PAY_ADVANCE_GPMB: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  PAY_SETTLEMENT_DEADLINE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  CALENDAR: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  UNIT: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: true },
  CURRENCY: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  DOCUMENT_TYPE: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  CONTRACT_TYPE: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  PAYMENT_TYPE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: true },
  CONTRACTOR_CRITERION: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  EXPERT_ROLE: { scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: false },
  CONTACT_PURPOSE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  LANGUAGE: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  RETENTION_POLICY: { scope: 'PLATFORM_ONLY', retireRequiresSuccessor: false },
  TREASURY_OFFICE: { scope: 'TENANT_ONLY', retireRequiresSuccessor: false },
};

const OWN_BY_DEFAULT = { scope: 'TENANT_ONLY' as const, retireRequiresSuccessor: false };

export interface ImpactPreview {
  /** Rows that refer to the entry, by `table.column`; only references that are used appear. */
  counts: Record<string, number>;
  total: number;
  computed_at: string;
}

export interface MasterRecordRow {
  id: string;
  namespace: MasterNamespace;
  masterType: string;
  businessKey: string;
  status: MasterRecordStatus;
  currentVersionId: string | null;
  version: number;
}

export interface MasterVersionRow {
  id: string;
  masterRecordId: string;
  masterType: string;
  code: string;
  revision: number;
  label: string;
  parentRecordId: string | null;
  attributes: Record<string, unknown>;
  validFrom: string;
  validUntil: string | null;
  status: string;
  legalBasis: string | null;
  contentSha256: string | null;
  approvedBy: string | null;
  changeRequestId: string | null;
}

/**
 * What the bulk import passes when it acts on the change requests of its own batch. A change request that a batch owns is decided and
 * published only as part of the batch (all of it or none of it), so every other caller is refused (409 STAGE_TRANSITION_DENIED, `import_batch`).
 */
export interface BatchAccess {
  viaImportBatch: true;
}

export interface ChangeRequestRow {
  id: string;
  changeKind: ChangeKind;
  masterType: string;
  masterRecordId: string | null;
  proposed: Record<string, unknown>;
  before: Record<string, unknown> | null;
  reason: string;
  evidenceDocumentId: string | null;
  impact: ImpactPreview | null;
  effectiveFrom: string;
  status: ChangeStatus;
  createdBy: string;
  reviewedBy: string | null;
  decidedAt: string | null;
  publishedBy: string | null;
  decisionDocumentId: string | null;
  /** The import batch that created the request; null for a request opened one by one. */
  importBatchId: string | null;
  version: number;
}

/** A change request with the entry it is about: what a reviewer sees, and the record version a publication must name in If-Match. */
export interface ChangeRequestDetail extends ChangeRequestRow {
  businessKey: string | null;
  recordVersion: number | null;
  recordStatus: MasterRecordStatus | null;
  recordNamespace: MasterNamespace | null;
  /** Creation time to the microsecond (UTC): the ordering key of the queue and its cursor. */
  createdAtKey: string;
}

export interface MasterSearchRow {
  id: string;
  namespace: MasterNamespace;
  masterType: string;
  businessKey: string;
  status: MasterRecordStatus;
  label: string | null;
  validFrom: string | null;
  validUntil: string | null;
  versionId: string | null;
  openChangeRequestId: string | null;
  version: number;
  /** What the version in force says, so that a catalogue screen lists the entries with their columns in one read. */
  revision: number | null;
  parentRecordId: string | null;
  legalBasis: string | null;
  attributes: Record<string, unknown> | null;
  /** What the tenant set on an entry of the platform through its alias (ST-MDM-002), in force on the date of the search. */
  aliasLabel: string | null;
  aliasOrder: number | null;
  /** The label the tenant sees: its alias when it has one, the label of the version in force otherwise. */
  displayLabel: string | null;
  displayOrder: number | null;
}

export interface MasterUsage {
  masterRecordId: string;
  /** The date the references were judged on; null: references to any version. */
  asOf: string | null;
  counts: Record<string, number>;
  total: number;
  samples: Array<{ reference: string; id: string }>;
}

export interface NewMasterRecord {
  masterType: string;
  businessKey: string;
  content: MasterContent;
  reason: string;
  evidenceDocumentId?: string | undefined;
}

export interface NewChangeRequest {
  kind: 'UPDATE' | 'RETIRE';
  masterType: string;
  masterRecordId: string;
  /** For UPDATE: the fields to change; the rest of the version in force is kept. */
  proposed: Partial<Pick<MasterContent, 'label' | 'attributes' | 'parentRecordId' | 'validUntil' | 'legalBasis'>>;
  effectiveFrom: string;
  reason: string;
  evidenceDocumentId?: string | undefined;
  successorRecordId?: string | undefined;
}

interface ChangeRow {
  id: string;
  change_kind: ChangeKind;
  master_type: string;
  master_record_id: string | null;
  proposed_json: Record<string, unknown>;
  before_json: Record<string, unknown> | null;
  reason: string;
  evidence_document_id: string | null;
  impact_json: ImpactPreview | null;
  effective_from: string;
  status: ChangeStatus;
  created_by: string;
  reviewed_by: string | null;
  decided_at: string | null;
  published_by: string | null;
  decision_document_id: string | null;
  import_batch_id: string | null;
  version: string;
}

const CHANGE_COLUMN_LIST = [
  'id',
  'change_kind',
  'master_type',
  'master_record_id',
  'proposed_json',
  'before_json',
  'reason',
  'evidence_document_id',
  'impact_json',
  'effective_from::text as effective_from',
  'status',
  'created_by',
  'reviewed_by',
  'decided_at::text as decided_at',
  'published_by',
  'decision_document_id',
  'import_batch_id',
  'version::text as version',
];
const CHANGE_COLUMNS = CHANGE_COLUMN_LIST.join(', ');
const KEY_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
// A change request with the entry it is about (the key and the version a publication names in If-Match).
const DETAIL_SELECT = `select ${CHANGE_COLUMN_LIST.map((column) => `c.${column}`).join(', ')},
  r.business_key as record_business_key, r.version::text as record_version, r.status as record_status, r.namespace as record_namespace,
  to_char(c.created_at at time zone 'UTC', ${KEY_FORMAT}) as created_at_key
  from machvon.master_change_request c left join machvon.master_record r on r.id = c.master_record_id`;

const VERSION_COLUMNS = `v.id, v.master_record_id, v.master_type, v.code, v.revision, v.label, v.parent_id, v.attributes, v.valid_from::text as valid_from,
  v.valid_until::text as valid_until, v.status, v.legal_basis, v.content_sha256, v.approved_by, v.change_request_id`;

interface VersionSqlRow {
  id: string;
  master_record_id: string;
  master_type: string;
  code: string;
  revision: number;
  label: string;
  parent_id: string | null;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_until: string | null;
  status: string;
  legal_basis: string | null;
  content_sha256: string | null;
  approved_by: string | null;
  change_request_id: string | null;
}

interface RecordSqlRow {
  id: string;
  namespace: MasterNamespace;
  master_type: string;
  business_key: string;
  status: MasterRecordStatus;
  current_version_id: string | null;
  version: string;
}

const toChange = (row: ChangeRow): ChangeRequestRow => ({
  id: row.id,
  changeKind: row.change_kind,
  masterType: row.master_type,
  masterRecordId: row.master_record_id,
  proposed: row.proposed_json,
  before: row.before_json,
  reason: row.reason,
  evidenceDocumentId: row.evidence_document_id,
  impact: row.impact_json,
  effectiveFrom: row.effective_from,
  status: row.status,
  createdBy: row.created_by,
  reviewedBy: row.reviewed_by,
  decidedAt: row.decided_at,
  publishedBy: row.published_by,
  decisionDocumentId: row.decision_document_id,
  importBatchId: row.import_batch_id,
  version: Number(row.version),
});

interface DetailRow extends ChangeRow {
  record_business_key: string | null;
  record_version: string | null;
  record_status: MasterRecordStatus | null;
  record_namespace: MasterNamespace | null;
  created_at_key: string;
}

const toDetail = (row: DetailRow): ChangeRequestDetail => ({
  ...toChange(row),
  businessKey: row.record_business_key,
  recordVersion: row.record_version === null ? null : Number(row.record_version),
  recordStatus: row.record_status,
  recordNamespace: row.record_namespace,
  createdAtKey: row.created_at_key,
});

const toVersion = (row: VersionSqlRow): MasterVersionRow => ({
  id: row.id,
  masterRecordId: row.master_record_id,
  masterType: row.master_type,
  code: row.code,
  revision: row.revision,
  label: row.label,
  parentRecordId: row.parent_id,
  attributes: row.attributes,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  legalBasis: row.legal_basis,
  contentSha256: row.content_sha256,
  approvedBy: row.approved_by,
  changeRequestId: row.change_request_id,
});

const toRecord = (row: RecordSqlRow): MasterRecordRow => ({
  id: row.id,
  namespace: row.namespace,
  masterType: row.master_type,
  businessKey: row.business_key,
  status: row.status,
  currentVersionId: row.current_version_id,
  version: Number(row.version),
});

const STATE_OF: Readonly<Record<ChangeStatus, ChangeRequestState | undefined>> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  APPLIED: 'Applied',
  CANCELLED: undefined,
};
const STATUS_OF: Readonly<Record<ChangeRequestState, ChangeStatus>> = { Draft: 'DRAFT', Submitted: 'IN_REVIEW', Approved: 'APPROVED', Rejected: 'REJECTED', Applied: 'APPLIED' };

/** The status after `action`; a cancelled request has no state to leave. */
function advance(status: ChangeStatus, action: ChangeRequestAction): ChangeStatus {
  const from = STATE_OF[status];
  if (from === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${status}->${action}`);
  return STATUS_OF[changeRequestNext(from, action)];
}

const today = (): string => vietnamDateOf(new Date());

/** The hash that identifies one version's content: the same content always has the same hash, whatever the key order. */
export function contentHashOf(masterType: string, businessKey: string, content: MasterContent): string {
  return sha256Hex(
    canonicalJson({
      master_type: masterType,
      business_key: businessKey,
      label: content.label,
      attributes: content.attributes,
      parent_record_id: content.parentRecordId,
      valid_from: content.validFrom,
      valid_until: content.validUntil,
      legal_basis: content.legalBasis,
    }),
  );
}

function assertReferences(references: readonly MasterReference[]): void {
  for (const reference of references) {
    if (!IDENTIFIER.test(reference.table) || !IDENTIFIER.test(reference.column)) throw new Error(`master reference ${reference.key} is not a table.column identifier`);
  }
}

/**
 * Versioned master data (ST-MDM-001, MDM 3.1): a record is the stable identity of an entry (type and business key), its versions
 * are the effective-dated facts. A change is a change request (proposed, impact previewed, decided by a second person, published
 * by a third party to the proposer) and publishing it never rewrites history: the previous version is closed at the effective
 * date and the new one starts there, so a report keeps the name and code that were valid on its business date.
 */
export class MasterStore {
  private readonly references: readonly MasterReference[];

  constructor(references: readonly MasterReference[] = MASTER_REFERENCES) {
    assertReferences(references);
    this.references = references;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  async findRecord(tx: TenantTx, id: string, lock = false): Promise<MasterRecordRow | undefined> {
    const rows = await tx.query<RecordSqlRow>(
      `select id, namespace, master_type, business_key, status, current_version_id, version::text as version
         from machvon.master_record where id = $1::uuid${lock ? ' for update' : ''}`,
      [id],
    );
    return rows[0] === undefined ? undefined : toRecord(rows[0]);
  }

  async findChange(tx: TenantTx, id: string, lock = false): Promise<ChangeRequestRow | undefined> {
    const rows = await tx.query<ChangeRow>(`select ${CHANGE_COLUMNS} from machvon.master_change_request where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toChange(rows[0]);
  }

  /**
   * The change requests, oldest first (a fair queue for the reviewers), optionally of one status and one master type. The cursor
   * is the creation time (to the microsecond, UTC) and the id of the last row.
   */
  async listChanges(
    tx: TenantTx,
    request: { status?: ChangeStatus | undefined; masterType?: string | undefined; limit: number; after: { code: string; id: string } | undefined },
  ): Promise<ChangeRequestDetail[]> {
    const rows = await tx.query<DetailRow>(
      `${DETAIL_SELECT}
        where ($1::text is null or c.status = $1) and ($2::text is null or c.master_type = $2)
          and ($3::text is null or (to_char(c.created_at at time zone 'UTC', ${KEY_FORMAT}), c.id) > ($3::text, $4::uuid))
        order by c.created_at, c.id
        limit $5`,
      [request.status ?? null, request.masterType ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toDetail);
  }

  /** One change request with the entry it is about (no lock: the reads use it). */
  async findChangeDetail(tx: TenantTx, id: string): Promise<ChangeRequestDetail | undefined> {
    const rows = await tx.query<DetailRow>(`${DETAIL_SELECT} where c.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toDetail(rows[0]);
  }

  async findVersion(tx: TenantTx, id: string): Promise<MasterVersionRow | undefined> {
    const rows = await tx.query<VersionSqlRow>(`select ${VERSION_COLUMNS} from machvon.master_record_version v where v.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  /** The versions in the order of their master type, code and revision, for the generic read scaffold; `masterRecordId` keeps one entry's history. */
  async listVersions(tx: TenantTx, request: { limit: number; after: { code: string; id: string } | undefined; masterRecordId?: string | undefined }): Promise<MasterVersionRow[]> {
    const rows = await tx.query<VersionSqlRow>(
      `select ${VERSION_COLUMNS} from machvon.master_record_version v
        where ($1::text is null or (v.master_type || ':' || v.code || ':' || lpad(v.revision::text, 9, '0'), v.id) > ($1::text, $2::uuid))
          and ($4::uuid is null or v.master_record_id = $4::uuid)
        order by v.master_type || ':' || v.code || ':' || lpad(v.revision::text, 9, '0'), v.id
        limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, request.masterRecordId ?? null],
    );
    return rows.map(toVersion);
  }

  async versionOfRecord(tx: TenantTx, recordId: string, versionId: string): Promise<MasterVersionRow | undefined> {
    const rows = await tx.query<VersionSqlRow>(`select ${VERSION_COLUMNS} from machvon.master_record_version v where v.id = $1::uuid and v.master_record_id = $2::uuid`, [versionId, recordId]);
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  /** The version of a record in force on `asOf` (a published one), or undefined. */
  async versionInForce(tx: TenantTx, recordId: string, asOf: string): Promise<MasterVersionRow | undefined> {
    const rows = await tx.query<VersionSqlRow>(
      `select ${VERSION_COLUMNS} from machvon.master_record_version v
        where v.master_record_id = $1::uuid and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.published_at is not null
          and v.valid_from <= $2::date and (v.valid_until is null or v.valid_until > $2::date)
        order by v.revision desc limit 1`,
      [recordId, asOf],
    );
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  async search(
    tx: TenantTx,
    request: { masterType?: string | undefined; businessKey?: string | undefined; namespace?: MasterNamespace | undefined; asOf: string; limit: number; after: { code: string; id: string } | undefined },
  ): Promise<MasterSearchRow[]> {
    const rows = await tx.query<{
      id: string;
      namespace: MasterNamespace;
      master_type: string;
      business_key: string;
      status: MasterRecordStatus;
      version: string;
      label: string | null;
      valid_from: string | null;
      valid_until: string | null;
      version_id: string | null;
      open_change_request_id: string | null;
      revision: number | null;
      parent_id: string | null;
      legal_basis: string | null;
      attributes: Record<string, unknown> | null;
      alias_label: string | null;
      alias_order: string | null;
      sort_key: string;
    }>(
      `select r.id, r.namespace, r.master_type, r.business_key, r.status, r.version::text as version,
              v.label, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.id as version_id,
              v.revision, v.parent_id, v.legal_basis, v.attributes,
              c.id as open_change_request_id, r.master_type || ':' || r.business_key as sort_key,
              (select a.external_code from machvon.master_crosswalk a
                where a.master_record_id = r.id and a.source_system = 'TENANT_ALIAS' and a.external_type = 'LABEL' and a.status = 'ACTIVE'
                  and a.valid_from <= $4::date and (a.valid_until is null or a.valid_until > $4::date) limit 1) as alias_label,
              (select a.external_code from machvon.master_crosswalk a
                where a.master_record_id = r.id and a.source_system = 'TENANT_ALIAS' and a.external_type = 'ORDER' and a.status = 'ACTIVE'
                  and a.valid_from <= $4::date and (a.valid_until is null or a.valid_until > $4::date) limit 1) as alias_order
         from machvon.master_record r
         left join lateral (
           select * from machvon.master_record_version x
            where x.master_record_id = r.id and x.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and x.published_at is not null
              and x.valid_from <= $4::date and (x.valid_until is null or x.valid_until > $4::date)
            order by x.revision desc limit 1
         ) v on true
         left join lateral (
           select y.id from machvon.master_change_request y
            where y.master_record_id = r.id and y.status in ('DRAFT', 'IN_REVIEW', 'APPROVED')
            order by y.created_at desc limit 1
         ) c on true
        where ($1::text is null or r.master_type = $1) and ($2::text is null or r.business_key = $2) and ($3::text is null or r.namespace = $3)
          and ($5::text is null or (r.master_type || ':' || r.business_key, r.id) > ($5::text, $6::uuid))
        order by r.master_type || ':' || r.business_key, r.id
        limit $7`,
      [request.masterType ?? null, request.businessKey ?? null, request.namespace ?? null, request.asOf, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      namespace: row.namespace,
      masterType: row.master_type,
      businessKey: row.business_key,
      status: row.status,
      label: row.label,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      versionId: row.version_id,
      openChangeRequestId: row.open_change_request_id,
      version: Number(row.version),
      revision: row.revision,
      parentRecordId: row.parent_id,
      legalBasis: row.legal_basis,
      attributes: row.attributes,
      aliasLabel: row.alias_label,
      aliasOrder: row.alias_order === null ? null : Number(row.alias_order),
      displayLabel: row.alias_label ?? row.label,
      displayOrder: row.alias_order === null ? null : Number(row.alias_order),
    }));
  }

  /**
   * Counts the rows that refer to the record or to any of its versions, per referencing column (RLS keeps it to the tenant). With
   * `asOf`, a reference by version counts only when it points at the version that was in force on that date.
   */
  async usage(tx: TenantTx, recordId: string, asOf?: string, sampleSize = 5): Promise<MasterUsage> {
    const counts: Record<string, number> = {};
    const samples: Array<{ reference: string; id: string }> = [];
    let total = 0;
    const inForce = asOf === undefined ? undefined : await this.versionInForce(tx, recordId, asOf);
    for (const reference of this.references) {
      const { sql, params } = this.targetOf(reference, recordId, asOf === undefined ? 'all' : (inForce?.id ?? null));
      const rows = await tx.query<{ id: string }>(`select id from machvon.${reference.table} where ${sql} order by id limit ${sampleSize + 1}`, params);
      if (rows.length === 0) continue;
      const counted = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.${reference.table} where ${sql}`, params);
      const n = Number((counted[0] as { n: string }).n);
      counts[reference.key] = n;
      total += n;
      for (const row of rows.slice(0, sampleSize)) samples.push({ reference: reference.key, id: row.id });
    }
    // The entries that name this one by its key inside their attributes (an issue group names its priority, a programme its source).
    const record = await this.findRecord(tx, recordId);
    if (record !== undefined) {
      for (const reference of attributeReferencesTo(record.masterType)) {
        const withField = [reference.owner, record.businessKey, reference.field, recordId];
        const withoutField = [reference.owner, record.businessKey, recordId];
        const { condition, params } = {
          key: { condition: 'v.attributes ->> $3 = $2 and r.id <> $4::uuid', params: withField },
          keys: { condition: 'v.attributes -> $3 @> to_jsonb($2::text) and r.id <> $4::uuid', params: withField },
          bandsGroup: { condition: "jsonb_path_exists(v.attributes, '$.bands[*] ? (@.group_key == $k)', jsonb_build_object('k', $2::text)) and r.id <> $3::uuid", params: withoutField },
          bandsSector: { condition: "jsonb_path_exists(v.attributes, '$.bands[*] ? (@.sector_key == $k)', jsonb_build_object('k', $2::text)) and r.id <> $3::uuid", params: withoutField },
        }[reference.shape];
        const where = `r.master_type = $1 and r.status not in ('RETIRED', 'MERGED') and ${condition}`;
        const from = `machvon.master_record r join lateral (select x.attributes from machvon.master_record_version x where x.master_record_id = r.id order by x.revision desc limit 1) v on true`;
        const rows = await tx.query<{ id: string }>(`select r.id from ${from} where ${where} order by r.id limit ${sampleSize + 1}`, params);
        if (rows.length === 0) continue;
        const counted = await tx.query<{ n: string }>(`select count(*)::text as n from ${from} where ${where}`, params);
        const key = `${reference.owner}.attributes.${reference.field}`;
        const n = Number((counted[0] as { n: string }).n);
        counts[key] = (counts[key] ?? 0) + n;
        total += n;
        for (const row of rows.slice(0, sampleSize)) samples.push({ reference: key, id: row.id });
      }
    }
    return { masterRecordId: recordId, asOf: asOf ?? null, counts, total, samples };
  }

  /** The condition that selects the rows referring to the record: to any version ('all'), to one version, or to nothing (null). */
  private targetOf(reference: MasterReference, recordId: string, versions: 'all' | string | null): { sql: string; params: unknown[] } {
    if (reference.kind === 'byRecord') return { sql: `${reference.column} = $1::uuid`, params: [recordId] };
    if (versions === 'all') return { sql: `${reference.column} in (select id from machvon.master_record_version where master_record_id = $1::uuid)`, params: [recordId] };
    return { sql: `${reference.column} = $1::uuid`, params: [versions] };
  }

  /** What refers to the entry now: the preview a reviewer reads before a change (ST-MDM-001) or a succession (ST-MDM-009) is decided. */
  async impactOf(tx: TenantTx, recordId: string | null): Promise<ImpactPreview> {
    const computedAt = new Date().toISOString();
    if (recordId === null) return { counts: {}, total: 0, computed_at: computedAt };
    const usage = await this.usage(tx, recordId, undefined, 0);
    return { counts: usage.counts, total: usage.total, computed_at: computedAt };
  }

  // ---- the policy of the types -----------------------------------------------------------------------------------

  /** The policy of one type: the row of the tenant, else the baseline of the platform, else the type is the tenant's own. */
  async policyOf(tx: TenantTx, masterType: string): Promise<TypePolicy> {
    const rows = await tx.query<{ scope: TypeScope; retire_requires_successor: boolean }>('select scope, retire_requires_successor from machvon.master_type_policy where master_type = $1', [masterType]);
    const row = rows[0];
    if (row !== undefined) return { masterType, scope: row.scope, retireRequiresSuccessor: row.retire_requires_successor, source: 'TENANT' };
    const baseline = BASELINE_POLICIES[masterType] ?? OWN_BY_DEFAULT;
    return { masterType, ...baseline, source: 'BASELINE' };
  }

  /** Every type the tenant has or the platform governs, with its policy and how many entries of each namespace it holds. */
  async listPolicies(tx: TenantTx): Promise<TypePolicySummary[]> {
    const rows = await tx.query<{ master_type: string; platform_records: string; tenant_records: string }>(
      `select t.master_type,
              count(r.id) filter (where r.namespace = 'PLATFORM')::text as platform_records,
              count(r.id) filter (where r.namespace = 'TENANT')::text as tenant_records
         from (select master_type from machvon.master_record union select master_type from machvon.master_type_policy union select unnest($1::text[])) t
         left join machvon.master_record r on r.master_type = t.master_type
        group by t.master_type order by t.master_type`,
      [Object.keys(BASELINE_POLICIES)],
    );
    const result: TypePolicySummary[] = [];
    for (const row of rows) {
      result.push({ ...(await this.policyOf(tx, row.master_type)), platformRecords: Number(row.platform_records), tenantRecords: Number(row.tenant_records) });
    }
    return result;
  }

  /** A tenant writes only what the policy of the type leaves to it; the rest is 403 POLICY_LOCKED naming the field that locks it. */
  private async assertTenantMayAdd(tx: TenantTx, masterType: string, parentRecordId: string | null): Promise<void> {
    const policy = await this.policyOf(tx, masterType);
    if (policy.scope === 'PLATFORM_ONLY') throw new DomainError('POLICY_LOCKED', 403, 'master_type');
    if (policy.scope === 'PLATFORM_WITH_TENANT_EXTENSION') {
      const parent = parentRecordId === null ? undefined : await this.findRecord(tx, parentRecordId);
      if (parent === undefined || parent.namespace !== 'PLATFORM') throw new DomainError('POLICY_LOCKED', 403, 'parent_record_id');
    }
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /**
   * Creates the record, its first (draft) version and the CREATE change request in one step; the key is unique per type and namespace.
   * The references of the content are judged against the database, or against `lookup` when the caller creates a set of entries that
   * refer to each other in one transaction (the bulk import, which has already judged the set as a whole).
   */
  async propose(
    tx: TenantTx,
    input: NewMasterRecord,
    actor: string,
    lookup: TypeLookup = tenantLookup(tx),
  ): Promise<{ recordId: string; versionId: string; changeRequestId: string; version: number }> {
    const { content } = input;
    if (content.validUntil !== null && content.validUntil <= content.validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    if (content.parentRecordId !== null) await this.assertParent(tx, content.parentRecordId, input.masterType);
    await this.assertTenantMayAdd(tx, input.masterType, content.parentRecordId);
    await this.assertContent(tx, input.masterType, input.businessKey, content, lookup);
    let recordId: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, steward_membership_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'TENANT', $1, $2, 'DRAFT', $3::uuid, $3::uuid, $3::uuid)
         returning id`,
        [input.masterType, input.businessKey, actor],
      );
      recordId = (rows[0] as { id: string }).id;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DUPLICATE_KEY', 409);
      throw error;
    }
    const hash = contentHashOf(input.masterType, input.businessKey, content);
    const versionRows = await tx.query<{ id: string }>(
      `insert into machvon.master_record_version
         (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace,
          legal_basis, content_sha256, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, 1, $4, $5::uuid, $6::jsonb, $7::date, $8::date,
          'DRAFT', 'TENANT', $9, $10, $11::uuid, $11::uuid)
       returning id`,
      [recordId, input.masterType, input.businessKey, content.label, content.parentRecordId, JSON.stringify(content.attributes), content.validFrom, content.validUntil, content.legalBasis, hash, actor],
    );
    const versionId = (versionRows[0] as { id: string }).id;
    const impact = await this.impactOf(tx, null);
    const changeRows = await tx.query<{ id: string }>(
      `insert into machvon.master_change_request
         (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, evidence_document_id, impact_json, effective_from, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'CREATE', $1, $2::uuid, $3::jsonb, $4, $5::uuid, $6::jsonb, $7::date,
          'DRAFT', $8::uuid, $8::uuid)
       returning id`,
      [input.masterType, recordId, JSON.stringify(proposedJsonOf(content)), input.reason, input.evidenceDocumentId ?? null, JSON.stringify(impact), content.validFrom, actor],
    );
    const changeRequestId = (changeRows[0] as { id: string }).id;
    await tx.query('update machvon.master_record_version set change_request_id = $2::uuid where id = $1::uuid', [versionId, changeRequestId]);
    return { recordId, versionId, changeRequestId, version: 1 };
  }

  /** The rules of the type (which attributes it takes, which entries it refers to) that the content has to meet before anyone can review it. */
  private async assertContent(tx: TenantTx, masterType: string, businessKey: string, content: MasterContent, lookup: TypeLookup = tenantLookup(tx)): Promise<void> {
    const parent = content.parentRecordId === null ? undefined : await entryOfRecord(tx, content.parentRecordId);
    await validateMasterContent({ masterType, businessKey, content, parent, lookup });
  }

  /** A change request of an import batch is acted on only through the batch, whose decision and publication are all or nothing. */
  private assertNotBatchOwned(change: ChangeRequestRow, access: BatchAccess | undefined): void {
    if (change.importBatchId !== null && access?.viaImportBatch !== true) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'import_batch');
  }

  private async assertParent(tx: TenantTx, parentRecordId: string, masterType: string): Promise<void> {
    const parent = await this.findRecord(tx, parentRecordId);
    if (parent === undefined || parent.masterType !== masterType) throw new DomainError('VALIDATION_FAILED', 422, 'parent_record_id');
  }

  /**
   * Rule data is decided and published by the owner of the module that applies it (BR-MDM-09): the control plane names the owners of a
   * rule type for the tenant, and a type with no owner cannot be approved by anyone.
   */
  private async assertRuleOwner(tx: TenantTx, masterType: string, actor: string): Promise<void> {
    if (!isRuleType(masterType)) return;
    const owners = await tx.query('select 1 from machvon.master_type_approver where master_type = $1 and membership_id = $2::uuid', [masterType, actor]);
    if (owners.length === 0) throw new DomainError('SCOPE_DENIED', 403, 'master_type');
  }

  /** Opens an UPDATE or RETIRE change request on a record in force and stores its impact preview before anyone can submit it. */
  async createChange(tx: TenantTx, input: NewChangeRequest, actor: string): Promise<{ id: string; version: number }> {
    const record = await this.findRecord(tx, input.masterRecordId, true);
    if (record === undefined || record.masterType !== input.masterType) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (record.namespace !== 'TENANT') throw new DomainError('POLICY_LOCKED', 403);
    if (record.status !== 'EFFECTIVE') throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${record.status}->${input.kind}`);
    const current = record.currentVersionId === null ? undefined : await this.findVersion(tx, record.currentVersionId);
    if (current === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${record.status}->${input.kind}`);
    if (input.effectiveFrom <= current.validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    // A change that is already published for a later date has closed the version in force at that date: the next one waits for it.
    const waiting = await tx.query(
      `select 1 from machvon.master_record_version where master_record_id = $1::uuid and revision > $2
        union all select 1 from machvon.master_change_request where master_record_id = $1::uuid and change_kind in ('RETIRE', 'SUCCESSION') and status = 'APPLIED' and effective_from > $3::date`,
      [record.id, current.revision, today()],
    );
    if (waiting.length > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'a published change is waiting for its date');

    const before = contentOf(current);
    let proposed: Record<string, unknown>;
    if (input.kind === 'UPDATE') {
      const merged: MasterContent = {
        label: input.proposed.label ?? before.label,
        attributes: input.proposed.attributes ?? before.attributes,
        parentRecordId: input.proposed.parentRecordId === undefined ? before.parentRecordId : input.proposed.parentRecordId,
        validFrom: input.effectiveFrom,
        // The end date is kept unless the request names it (null removes it): a rename must not make an entry that expires last for ever.
        validUntil: input.proposed.validUntil === undefined ? before.validUntil : input.proposed.validUntil,
        legalBasis: input.proposed.legalBasis === undefined ? before.legalBasis : input.proposed.legalBasis,
      };
      if (merged.validUntil !== null && merged.validUntil <= merged.validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
      if (merged.parentRecordId !== null) {
        if (merged.parentRecordId === record.id) throw new DomainError('VALIDATION_FAILED', 422, 'parent_record_id');
        await this.assertParent(tx, merged.parentRecordId, record.masterType);
      }
      await this.assertContent(tx, record.masterType, record.businessKey, merged);
      // A change that leaves the content as it is (the date apart) changes nothing and is refused.
      if (contentHashOf(record.masterType, record.businessKey, { ...merged, validFrom: current.validFrom }) === current.contentSha256) throw new DomainError('VALIDATION_FAILED', 422, 'proposed');
      proposed = proposedJsonOf(merged);
    } else {
      proposed = {};
    }
    const impact = await this.impactOf(tx, record.id);
    let successor: string | undefined;
    if (input.kind === 'RETIRE') {
      successor = input.successorRecordId;
      if (impact.total > 0 && successor === undefined) throw new DomainError('MASTER_IN_USE', 409);
      // A type that keeps its history through succession (the funding sources, the units) is never retired without one.
      if ((await this.policyOf(tx, record.masterType)).retireRequiresSuccessor && successor === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'successor_record_id');
      if (successor !== undefined) await this.assertSuccessor(tx, successor, record);
    }
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.master_change_request
           (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, before_json, reason, evidence_document_id, impact_json, effective_from,
            status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::uuid, $4::jsonb, $5::jsonb, $6, $7::uuid, $8::jsonb,
            $9::date, 'DRAFT', $10::uuid, $10::uuid)
         returning id`,
        [
          input.kind,
          record.masterType,
          record.id,
          JSON.stringify(successor === undefined ? proposed : { ...proposed, successor_record_id: successor }),
          JSON.stringify(proposedJsonOf(before)),
          input.reason,
          input.evidenceDocumentId ?? null,
          JSON.stringify(impact),
          input.effectiveFrom,
          actor,
        ],
      );
      return { id: (rows[0] as { id: string }).id, version: 1 };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'a change request is already open');
      throw error;
    }
  }

  private async assertSuccessor(tx: TenantTx, successorId: string, retiring: MasterRecordRow): Promise<void> {
    const successor = await this.findRecord(tx, successorId);
    if (successor === undefined || successor.id === retiring.id || successor.masterType !== retiring.masterType || successor.status !== 'EFFECTIVE') {
      throw new DomainError('VALIDATION_FAILED', 422, 'successor_record_id');
    }
  }

  private async lockChange(tx: TenantTx, id: string, expectedVersion: number): Promise<ChangeRequestRow> {
    const change = await this.findChange(tx, id, true);
    if (change === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (change.version !== expectedVersion) throw versionConflict(change.version);
    return change;
  }

  /** Draft → In review. The impact preview must exist; it is computed again, since the references may have changed since it was stored. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string, access?: BatchAccess): Promise<{ change: ChangeRequestRow; version: number; impact: ImpactPreview }> {
    const change = await this.lockChange(tx, id, expectedVersion);
    this.assertNotBatchOwned(change, access);
    const status = advance(change.status, 'submit');
    if (change.impact === null) throw new DomainError('IMPACT_NOT_COMPUTED', 422);
    const impact = await this.impactOf(tx, change.masterRecordId);
    if (change.changeKind === 'RETIRE' && impact.total > 0 && typeof change.proposed.successor_record_id !== 'string') throw new DomainError('MASTER_IN_USE', 409);
    // A succession goes to review only when it is whole (the shares of a split add up to 100) and still fits the graph.
    if (change.changeKind === 'SUCCESSION') await this.revalidateSuccession(tx, change);
    const rows = await tx.query<{ version: string }>(
      `update machvon.master_change_request set status = $2, impact_json = $3::jsonb, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [id, status, JSON.stringify(impact), actor],
    );
    if (change.changeKind === 'CREATE' && change.masterRecordId !== null) await this.moveNewRecord(tx, change.masterRecordId, 'IN_REVIEW', actor);
    return { change, version: Number((rows[0] as { version: string }).version), impact };
  }

  /** The first version of a new record follows its change request: DRAFT, IN_REVIEW, APPROVED. */
  private async moveNewRecord(tx: TenantTx, recordId: string, status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED', actor: string): Promise<void> {
    try {
      await tx.query(
        `update machvon.master_record_version set status = $2, approved_by = case when $2 = 'APPROVED' then $3::uuid else null end, updated_at = now(), updated_by = $3::uuid,
                version = version + 1
          where master_record_id = $1::uuid and revision = 1`,
        [recordId, status, actor],
      );
      await tx.query('update machvon.master_record set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [recordId, status, actor]);
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw new DomainError('EFFECTIVE_RANGE_OVERLAP', 409);
      throw error;
    }
  }

  /** The decision of a reviewer who is not the proposer: approve, reject, or return the request to its author. */
  async decide(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    decision: MasterDecision,
    reviewer: string,
    access?: BatchAccess,
  ): Promise<{ change: ChangeRequestRow; status: ChangeStatus; version: number }> {
    const change = await this.lockChange(tx, id, expectedVersion);
    this.assertNotBatchOwned(change, access);
    assertFourEyes(change.createdBy, reviewer);
    await this.assertRuleOwner(tx, change.masterType, reviewer);
    if (change.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${change.status}->${decision}`);
    const status = decision === 'approve' ? advance(change.status, 'approve') : decision === 'reject' ? advance(change.status, 'reject') : 'DRAFT';
    if (decision === 'approve' && change.changeKind === 'CREATE' && change.masterRecordId !== null) await this.moveNewRecord(tx, change.masterRecordId, 'APPROVED', reviewer);
    if (decision !== 'approve' && change.changeKind === 'CREATE' && change.masterRecordId !== null) await this.moveNewRecord(tx, change.masterRecordId, 'DRAFT', reviewer);
    const reviewed = decision === 'return' ? null : reviewer;
    const rows = await tx.query<{ version: string }>(
      `update machvon.master_change_request
          set status = $2, reviewed_by = $3::uuid, decided_at = case when $3::uuid is null then null else now() end, updated_at = now(), updated_by = $4::uuid,
              version = version + 1
        where id = $1::uuid returning version::text as version`,
      [id, status, reviewed, reviewer],
    );
    return { change, status, version: Number((rows[0] as { version: string }).version) };
  }

  /**
   * Publishes the approved change request of a record (never by its proposer): the previous version is closed at the effective
   * date, the new one starts there. A date in the future waits for the activation job; the exclusion constraint refuses overlaps.
   */
  async publish(
    tx: TenantTx,
    recordId: string,
    expectedVersion: number,
    decisionDocumentId: string,
    publisher: string,
    access?: BatchAccess,
  ): Promise<{ record: MasterRecordRow; change: ChangeRequestRow; versionId: string; version: number; active: boolean }> {
    const record = await this.findRecord(tx, recordId, true);
    if (record === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (record.version !== expectedVersion) throw versionConflict(record.version);
    const rows = await tx.query<ChangeRow>(
      `select ${CHANGE_COLUMNS} from machvon.master_change_request where master_record_id = $1::uuid and status = 'APPROVED' order by created_at desc limit 1 for update`,
      [recordId],
    );
    const change = rows[0] === undefined ? undefined : toChange(rows[0]);
    if (change === undefined) throw new DomainError('CHANGE_NOT_APPROVED', 409);
    this.assertNotBatchOwned(change, access);
    assertFourEyes(change.createdBy, publisher);
    await this.assertRuleOwner(tx, change.masterType, publisher);
    const documents = await tx.query('select 1 from machvon.document where id = $1::uuid', [decisionDocumentId]);
    if (documents.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'decision_document_id');
    advance(change.status, 'apply');
    if (change.changeKind === 'RETIRE') await this.revalidateRetirement(tx, record, change);
    if (change.changeKind === 'SUCCESSION') await this.revalidateSuccession(tx, change);

    const effective = change.effectiveFrom <= today();
    let versionId: string;
    try {
      versionId = await this.apply(tx, record, change, effective, publisher);
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw new DomainError('EFFECTIVE_RANGE_OVERLAP', 409);
      throw error;
    }
    await tx.query(
      `update machvon.master_change_request
          set status = 'APPLIED', published_by = $2::uuid, published_at = now(), decision_document_id = $3::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [change.id, publisher, decisionDocumentId],
    );
    let next = (await this.findRecord(tx, recordId)) as MasterRecordRow;
    // A publication that waits for its date leaves the record as it was; its version still advances, so each publication has an identity of its own.
    if (next.version === record.version) {
      await tx.query('update machvon.master_record set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [recordId, publisher]);
      next = (await this.findRecord(tx, recordId)) as MasterRecordRow;
    }
    return { record: next, change, versionId, version: next.version, active: effective };
  }

  /** What was true when the retirement was requested may not be true now: something may use the entry, or the successor may be gone. */
  private async revalidateRetirement(tx: TenantTx, record: MasterRecordRow, change: ChangeRequestRow): Promise<void> {
    const successor = typeof change.proposed.successor_record_id === 'string' ? change.proposed.successor_record_id : undefined;
    const usage = await this.usage(tx, record.id, undefined, 0);
    if (usage.total > 0 && successor === undefined) throw new DomainError('MASTER_IN_USE', 409);
    if ((await this.policyOf(tx, record.masterType)).retireRequiresSuccessor && successor === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'successor_record_id');
    if (successor !== undefined) await this.assertSuccessor(tx, successor, record);
  }

  /** What was true when the succession was recorded may not be true now: the proposal must still be whole and every edge must still fit the graph. */
  private async revalidateSuccession(tx: TenantTx, change: ChangeRequestRow): Promise<void> {
    const proposal = proposalOf(change.proposed);
    assertComplete(proposal);
    await lockSuccessionGraph(tx);
    const predecessor = change.masterRecordId === null ? undefined : await this.findRecord(tx, change.masterRecordId);
    if (predecessor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    for (const edge of proposal.edges) await assertEdgeAllowed(tx, this, predecessor, edge.successorRecordId, proposal.effectiveDate);
  }

  private async apply(tx: TenantTx, record: MasterRecordRow, change: ChangeRequestRow, effective: boolean, publisher: string): Promise<string> {
    if (change.changeKind === 'CREATE') {
      const first = await tx.query<{ id: string }>(
        `update machvon.master_record_version
            set status = $2, published_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1
          where master_record_id = $1::uuid and revision = 1 returning id`,
        [record.id, effective ? 'EFFECTIVE' : 'APPROVED', publisher],
      );
      const id = (first[0] as { id: string }).id;
      await this.setRecord(tx, record.id, effective ? 'EFFECTIVE' : 'APPROVED', effective ? id : null, publisher);
      return id;
    }
    const current = record.currentVersionId === null ? undefined : await this.findVersion(tx, record.currentVersionId);
    if (current === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'no version in force');
    if (change.effectiveFrom <= current.validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    // The version in force ends where the change starts (an earlier end date is kept), so the change can no longer overlap it.
    if (current.validUntil === null || current.validUntil > change.effectiveFrom) {
      await tx.query('update machvon.master_record_version set valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [
        current.id,
        change.effectiveFrom,
        publisher,
      ]);
    }
    // A retirement and a succession end the version in force the same way; a succession also records who took over (history is not rewritten: no new version).
    if (change.changeKind === 'RETIRE' || change.changeKind === 'SUCCESSION') {
      if (change.changeKind === 'SUCCESSION') await insertEdges(tx, change, record.id, proposalOf(change.proposed), publisher);
      if (effective) {
        await tx.query("update machvon.master_record_version set status = 'RETIRED' where id = $1::uuid", [current.id]);
        await this.setRecord(tx, record.id, 'RETIRED', current.id, publisher);
      }
      return current.id;
    }
    const proposed = change.proposed as { label: string; attributes: Record<string, unknown>; parent_record_id: string | null; valid_until: string | null; legal_basis: string | null };
    const content: MasterContent = {
      label: proposed.label,
      attributes: proposed.attributes,
      parentRecordId: proposed.parent_record_id,
      validFrom: change.effectiveFrom,
      validUntil: proposed.valid_until,
      legalBasis: proposed.legal_basis,
    };
    const created = await tx.query<{ id: string }>(
      `insert into machvon.master_record_version
         (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, supersedes_id,
          change_request_id, legal_basis, content_sha256, published_at, approved_by, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::date, $9::date, $10,
          'TENANT', $11::uuid, $12::uuid, $13, $14, now(), $15::uuid, $16::uuid, $16::uuid)
       returning id`,
      [
        record.id,
        record.masterType,
        record.businessKey,
        current.revision + 1,
        content.label,
        content.parentRecordId,
        JSON.stringify(content.attributes),
        content.validFrom,
        content.validUntil,
        effective ? 'EFFECTIVE' : 'APPROVED',
        current.id,
        change.id,
        content.legalBasis,
        contentHashOf(record.masterType, record.businessKey, content),
        change.reviewedBy,
        publisher,
      ],
    );
    const id = (created[0] as { id: string }).id;
    if (effective) await this.setRecord(tx, record.id, 'EFFECTIVE', id, publisher);
    return id;
  }

  private async setRecord(tx: TenantTx, recordId: string, status: MasterRecordStatus, currentVersionId: string | null, actor: string): Promise<void> {
    await tx.query(
      `update machvon.master_record set status = $2, current_version_id = coalesce($3::uuid, current_version_id), updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [recordId, status, currentVersionId, actor],
    );
  }

  /**
   * The daily activation (MDM-001 task 4): a published version whose date has come becomes the version in force, and a record whose
   * retirement date has come is retired. Idempotent. Returns how many records changed.
   */
  async activateDue(tx: TenantTx, actor: string, on = today()): Promise<number> {
    let changed = 0;
    const due = await tx.query<{ id: string; master_record_id: string }>(
      `select id, master_record_id from machvon.master_record_version where status = 'APPROVED' and published_at is not null and valid_from <= $1::date
        and master_record_id in (select id from machvon.master_record where status in ('APPROVED', 'EFFECTIVE')) order by valid_from, revision`,
      [on],
    );
    for (const row of due) {
      await tx.query("update machvon.master_record_version set status = 'EFFECTIVE', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [row.id, actor]);
      await this.setRecord(tx, row.master_record_id, 'EFFECTIVE', row.id, actor);
      changed += 1;
    }
    const ended = await tx.query<{ id: string; current_version_id: string }>(
      `select r.id, r.current_version_id from machvon.master_record r join machvon.master_record_version v on v.id = r.current_version_id
        where r.status = 'EFFECTIVE' and v.valid_until is not null and v.valid_until <= $1::date
          and not exists (select 1 from machvon.master_record_version n where n.master_record_id = r.id and n.revision > v.revision and n.status in ('APPROVED', 'EFFECTIVE'))`,
      [on],
    );
    for (const row of ended) {
      await tx.query("update machvon.master_record_version set status = 'RETIRED' where id = $1::uuid", [row.current_version_id]);
      await this.setRecord(tx, row.id, 'RETIRED', null, actor);
      changed += 1;
    }
    return changed;
  }

  /** How many change requests wait for a reviewer (the gauge `mdm_change_pending_gauge`). */
  async pendingReviews(tx: TenantTx): Promise<number> {
    const rows = await tx.query<{ n: string }>("select count(*)::text as n from machvon.master_change_request where status = 'IN_REVIEW'");
    return Number((rows[0] as { n: string }).n);
  }
}

function proposedJsonOf(content: MasterContent): Record<string, unknown> {
  return {
    label: content.label,
    attributes: content.attributes,
    parent_record_id: content.parentRecordId,
    valid_from: content.validFrom,
    valid_until: content.validUntil,
    legal_basis: content.legalBasis,
  };
}

function contentOf(version: MasterVersionRow): MasterContent {
  return {
    label: version.label,
    attributes: version.attributes,
    parentRecordId: version.parentRecordId,
    validFrom: version.validFrom,
    validUntil: version.validUntil,
    legalBasis: version.legalBasis,
  };
}
