import { randomUUID } from 'node:crypto';
import { DomainError, assertValidityPeriod, expiryState, foldForMatch, hasControlChar, matchKeyOf, qualificationFindings, versionConflict } from '@machvon/kernel';
import type { ExpiryState, ExpiryWarningPolicy, HeldQualification, QualificationGrade, QualificationKind, QualificationRequirement, RequirementFinding, StaffRole } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface QualificationRow {
  id: string;
  contractorId: string;
  kind: QualificationKind;
  certificateNo: string;
  grade: QualificationGrade | null;
  scope: string | null;
  issuer: string;
  issuedOn: string;
  expiresOn: string | null;
  documentId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdBy: string;
  version: number;
}

export interface KeyStaffRow {
  id: string;
  contractorId: string;
  staffRole: StaffRole;
  personName: string;
  qualificationTitle: string;
  certificateNo: string | null;
  issuedOn: string;
  expiresOn: string | null;
  documentId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdBy: string;
  version: number;
}

export interface NewQualification {
  kind: QualificationKind;
  certificateNo: string;
  grade?: QualificationGrade | undefined;
  scope?: string | undefined;
  issuer: string;
  issuedOn: string;
  expiresOn?: string | undefined;
  documentId?: string | undefined;
}

export interface NewKeyStaff {
  staffRole: StaffRole;
  personName: string;
  qualificationTitle: string;
  certificateNo?: string | undefined;
  issuedOn: string;
  expiresOn?: string | undefined;
  documentId?: string | undefined;
}

export interface RequirementRow {
  id: string;
  packageId: string;
  kind: QualificationKind;
  minGrade: QualificationGrade | null;
  scopeKeyword: string | null;
}

/** One line of the expiry watch: a certificate or a member of the staff, with the state the policy puts it in. */
export interface ExpiryItem {
  subject: 'QUALIFICATION' | 'KEY_STAFF';
  id: string;
  contractorId: string;
  contractorName: string;
  label: string;
  expiresOn: string;
  state: ExpiryState;
}

interface QualSql {
  id: string;
  contractor_id: string;
  kind: QualificationKind;
  certificate_no: string;
  grade: QualificationGrade | null;
  scope: string | null;
  issuer: string;
  issued_on: string;
  expires_on: string | null;
  document_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_by: string;
  version: string;
}

interface StaffSql {
  id: string;
  contractor_id: string;
  staff_role: StaffRole;
  person_name: string;
  qualification_title: string;
  certificate_no: string | null;
  issued_on: string;
  expires_on: string | null;
  document_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_by: string;
  version: string;
}

const QUAL_SELECT = `select id, contractor_id, kind, certificate_no, grade, scope, issuer, issued_on::text as issued_on, expires_on::text as expires_on, document_id, verified_by,
  to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as verified_at, to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as revoked_at, revoke_reason, created_by, version::text as version
  from machvon.contractor_qualification`;
const STAFF_SELECT = `select id, contractor_id, staff_role, person_name, qualification_title, certificate_no, issued_on::text as issued_on, expires_on::text as expires_on, document_id, verified_by,
  to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as verified_at, to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as revoked_at, revoke_reason, created_by, version::text as version
  from machvon.contractor_key_staff`;

const toQual = (row: QualSql): QualificationRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  kind: row.kind,
  certificateNo: row.certificate_no,
  grade: row.grade,
  scope: row.scope,
  issuer: row.issuer,
  issuedOn: row.issued_on,
  expiresOn: row.expires_on,
  documentId: row.document_id,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  createdBy: row.created_by,
  version: Number(row.version),
});

const toStaff = (row: StaffSql): KeyStaffRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  staffRole: row.staff_role,
  personName: row.person_name,
  qualificationTitle: row.qualification_title,
  certificateNo: row.certificate_no,
  issuedOn: row.issued_on,
  expiresOn: row.expires_on,
  documentId: row.document_id,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  createdBy: row.created_by,
  version: Number(row.version),
});

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

/** The held form of a certificate as the kernel judges it. */
export const heldOf = (row: QualificationRow): HeldQualification => ({
  id: row.id,
  kind: row.kind,
  grade: row.grade,
  scope: row.scope,
  period: { issuedOn: row.issuedOn, expiresOn: row.expiresOn, revoked: row.revokedAt !== null },
  verified: row.verifiedBy !== null,
});

/**
 * The certificates and the key staff of a contractor, and what a package asks of them (VND-1, V8). A certificate is verified by a person other than the one who entered it (the database holds that too) and one that
 * was not verified satisfies no requirement; it is revoked with a reason, never deleted, and its dates never change (a renewal is a new certificate), so what held on the day of a bid stays answerable.
 */
export class VendorQualificationStore {
  async qualifications(tx: TenantTx, contractorId: string): Promise<QualificationRow[]> {
    const rows = await tx.query<QualSql>(`${QUAL_SELECT} where contractor_id = $1::uuid order by kind, expires_on desc nulls first, id`, [contractorId]);
    return rows.map(toQual);
  }

  async keyStaff(tx: TenantTx, contractorId: string): Promise<KeyStaffRow[]> {
    const rows = await tx.query<StaffSql>(`${STAFF_SELECT} where contractor_id = $1::uuid order by staff_role, expires_on desc nulls first, id`, [contractorId]);
    return rows.map(toStaff);
  }

  private async assertContractor(tx: TenantTx, contractorId: string): Promise<void> {
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  private async assertDocument(tx: TenantTx, documentId: string | undefined): Promise<void> {
    if (documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [documentId])).length === 0) throw invalid('document_id');
  }

  /** `documentChecked`: the caller already proved the document is one it may name (the portal checks its own attachments; the register of documents is closed to the portal path). */
  async addQualification(tx: TenantTx, contractorId: string, input: NewQualification, actor: string, options: { documentChecked?: boolean } = {}): Promise<QualificationRow> {
    await this.assertContractor(tx, contractorId);
    assertValidityPeriod(input.issuedOn, input.expiresOn ?? null);
    if (options.documentChecked !== true) await this.assertDocument(tx, input.documentId);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_qualification (tenant_id, id, contractor_id, kind, certificate_no, grade, scope, issuer, issued_on, expires_on, document_id, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9::date, $10::uuid, $11::uuid, $11::uuid)`,
      [id, contractorId, input.kind, textOf(input.certificateNo, 'certificate_no', 1, 100), input.grade ?? null, input.scope === undefined ? null : textOf(input.scope, 'scope', 1, 500), textOf(input.issuer, 'issuer', 2, 300), input.issuedOn, input.expiresOn ?? null, input.documentId ?? null, actor],
    );
    return (await this.findQualification(tx, id)) as QualificationRow;
  }

  async findQualification(tx: TenantTx, id: string): Promise<QualificationRow | undefined> {
    const rows = await tx.query<QualSql>(`${QUAL_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toQual(rows[0]);
  }

  async addKeyStaff(tx: TenantTx, contractorId: string, input: NewKeyStaff, actor: string): Promise<KeyStaffRow> {
    await this.assertContractor(tx, contractorId);
    assertValidityPeriod(input.issuedOn, input.expiresOn ?? null);
    await this.assertDocument(tx, input.documentId);
    const name = textOf(input.personName, 'person_name', 2, 300);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_key_staff (tenant_id, id, contractor_id, staff_role, person_name, person_key, qualification_title, certificate_no, issued_on, expires_on, document_id, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9::date, $10::uuid, $11::uuid, $11::uuid)`,
      [id, contractorId, input.staffRole, name, matchKeyOf(foldForMatch(name)), textOf(input.qualificationTitle, 'qualification_title', 2, 300), input.certificateNo === undefined ? null : textOf(input.certificateNo, 'certificate_no', 1, 100), input.issuedOn, input.expiresOn ?? null, input.documentId ?? null, actor],
    );
    return (await this.findKeyStaff(tx, id)) as KeyStaffRow;
  }

  async findKeyStaff(tx: TenantTx, id: string): Promise<KeyStaffRow | undefined> {
    const rows = await tx.query<StaffSql>(`${STAFF_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toStaff(rows[0]);
  }

  /** A person other than the one who entered it checks the certificate or the member against the paper (403 `SELF_APPROVAL_DENIED`); once (409 `STAGE_TRANSITION_DENIED`). */
  async verify(tx: TenantTx, subject: 'QUALIFICATION' | 'KEY_STAFF', id: string, expectedVersion: number, actor: string): Promise<QualificationRow | KeyStaffRow> {
    const table = subject === 'QUALIFICATION' ? 'contractor_qualification' : 'contractor_key_staff';
    const [row] = await tx.query<{ created_by: string; verified_by: string | null; revoked_at: string | null; version: string; document_id: string | null }>(`select created_by, verified_by, revoked_at, version::text as version, document_id from machvon.${table} where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (row.verified_by !== null || row.revoked_at !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.document_id === null) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    await tx.query(`update machvon.${table} set verified_by = $2::uuid, verified_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor]);
    return (subject === 'QUALIFICATION' ? await this.findQualification(tx, id) : await this.findKeyStaff(tx, id)) as QualificationRow | KeyStaffRow;
  }

  /** Revokes a certificate or a member (a certificate the issuer withdrew, a person who left) with a reason; the row stays. */
  async revoke(tx: TenantTx, subject: 'QUALIFICATION' | 'KEY_STAFF', id: string, expectedVersion: number, reason: string, actor: string): Promise<QualificationRow | KeyStaffRow> {
    const table = subject === 'QUALIFICATION' ? 'contractor_qualification' : 'contractor_key_staff';
    const why = textOf(reason, 'reason', 5, 500);
    const [row] = await tx.query<{ revoked_at: string | null; version: string }>(`select revoked_at, version::text as version from machvon.${table} where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.revoked_at !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await tx.query(`update machvon.${table} set revoked_at = now(), revoked_by = $2::uuid, revoke_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor, why]);
    return (subject === 'QUALIFICATION' ? await this.findQualification(tx, id) : await this.findKeyStaff(tx, id)) as QualificationRow | KeyStaffRow;
  }

  // -- Requirements of a package ------------------------------------------------------------------------------------------------------------------------------------------------------------

  async requirements(tx: TenantTx, packageId: string): Promise<RequirementRow[]> {
    const rows = await tx.query<{ id: string; package_id: string; kind: QualificationKind; min_grade: QualificationGrade | null; scope_keyword: string | null }>(
      'select id, package_id, kind, min_grade, scope_keyword from machvon.package_qualification_requirement where package_id = $1::uuid order by kind',
      [packageId],
    );
    return rows.map((row) => ({ id: row.id, packageId: row.package_id, kind: row.kind, minGrade: row.min_grade, scopeKeyword: row.scope_keyword }));
  }

  /** Replaces what a package asks of its bidders (one line for a kind); an empty list asks nothing. */
  async setRequirements(tx: TenantTx, packageId: string, requirements: readonly QualificationRequirement[], actor: string): Promise<RequirementRow[]> {
    if ((await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [packageId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (new Set(requirements.map((one) => one.kind)).size !== requirements.length) throw invalid('requirements');
    await tx.query('delete from machvon.package_qualification_requirement where package_id = $1::uuid', [packageId]);
    for (const one of requirements) {
      await tx.query(
        `insert into machvon.package_qualification_requirement (tenant_id, id, package_id, kind, min_grade, scope_keyword, created_by) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5::uuid)`,
        [packageId, one.kind, one.minGrade, one.scopeKeyword === null ? null : textOf(one.scopeKeyword, 'scope_keyword', 1, 100), actor],
      );
    }
    return this.requirements(tx, packageId);
  }

  /** What the contractor lacks against a package: the gaps of the requirements the package set, judged on the day. */
  async findingsForPackage(tx: TenantTx, contractorId: string, packageId: string, today: string, policy: ExpiryWarningPolicy): Promise<RequirementFinding[]> {
    const requirements = (await this.requirements(tx, packageId)).map((row): QualificationRequirement => ({ kind: row.kind, minGrade: row.minGrade, scopeKeyword: row.scopeKeyword }));
    if (requirements.length === 0) return [];
    const held = (await this.qualifications(tx, contractorId)).map(heldOf);
    return qualificationFindings(requirements, held, today, policy);
  }

  /** Certificates and staff whose period ends within the first window of the policy (or already ended and not revoked), for the alert and the screen. */
  async expiring(tx: TenantTx, today: string, policies: { qualification: ExpiryWarningPolicy; keyStaff: ExpiryWarningPolicy }, limit = 500): Promise<ExpiryItem[]> {
    const horizon = Math.max(policies.qualification.first_warning_days, policies.keyStaff.first_warning_days);
    const quals = await tx.query<{ id: string; contractor_id: string; name: string; label: string; issued_on: string; expires_on: string }>(
      `select q.id, q.contractor_id, c.legal_name as name, q.kind || ' ' || q.certificate_no as label, q.issued_on::text as issued_on, q.expires_on::text as expires_on
         from machvon.contractor_qualification q join machvon.contractor c on c.tenant_id = q.tenant_id and c.id = q.contractor_id
        where q.revoked_at is null and q.expires_on is not null and q.expires_on <= $1::date + $2::int order by q.expires_on, q.id limit $3`,
      [today, horizon, limit],
    );
    const staff = await tx.query<{ id: string; contractor_id: string; name: string; label: string; issued_on: string; expires_on: string }>(
      `select s.id, s.contractor_id, c.legal_name as name, s.staff_role || ' ' || s.person_name as label, s.issued_on::text as issued_on, s.expires_on::text as expires_on
         from machvon.contractor_key_staff s join machvon.contractor c on c.tenant_id = s.tenant_id and c.id = s.contractor_id
        where s.revoked_at is null and s.expires_on is not null and s.expires_on <= $1::date + $2::int order by s.expires_on, s.id limit $3`,
      [today, horizon, limit],
    );
    const items: ExpiryItem[] = [];
    for (const row of quals) items.push({ subject: 'QUALIFICATION', id: row.id, contractorId: row.contractor_id, contractorName: row.name, label: row.label, expiresOn: row.expires_on, state: expiryState({ issuedOn: row.issued_on, expiresOn: row.expires_on, revoked: false }, today, policies.qualification) });
    for (const row of staff) items.push({ subject: 'KEY_STAFF', id: row.id, contractorId: row.contractor_id, contractorName: row.name, label: row.label, expiresOn: row.expires_on, state: expiryState({ issuedOn: row.issued_on, expiresOn: row.expires_on, revoked: false }, today, policies.keyStaff) });
    return items.filter((item) => item.state === 'EXPIRING_FIRST' || item.state === 'EXPIRING_SECOND' || item.state === 'EXPIRED').sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
  }
}
