import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, layoutFromBody, versionConflict } from '@machvon/kernel';
import type { LayoutProfileBody } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const EXCLUSION_VIOLATION = '23P01';
const CODE_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('doc_layout:' || current_setting('app.tenant_id') || ':' || $1::text, 0))";
const PROFILE_CODE = /^[A-Z0-9][A-Z0-9_.-]{2,59}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_LEGAL_BASIS = 2000;
const MAX_REF = 50;
const MAX_PAGE = 200;

export type LayoutStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export type LayoutConfirmation = 'CONFIRMED' | 'PENDING_CONFIRMATION';

export interface LayoutProfileDetail {
  id: string;
  profileCode: string;
  revision: number;
  pageSize: string;
  marginsMm: Record<string, number>;
  fontFamily: string;
  fontSubstitute: string | null;
  elementStyles: Record<string, unknown>;
  signatureLayout: Record<string, unknown>;
  numberFieldLayout: Record<string, unknown>;
  watermarkPolicy: Record<string, unknown>;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: LayoutConfirmation;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: LayoutStatus;
  createdBy: string;
  approvedBy: string | null;
  version: number;
}

export interface NewLayoutRevision extends LayoutProfileBody {
  profileCode: string;
  legalBasis: string;
  legalConfirmationRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  actor: string;
}

export interface LayoutFilter {
  profileCode?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  after?: { profileCode: string; revision: number } | undefined;
}

export interface ClosedProfile {
  id: string;
  revision: number;
  effectiveUntil: string;
}

interface ProfileSql {
  id: string;
  profile_code: string;
  revision: number;
  page_size: string;
  margins_mm: Record<string, number>;
  font_family: string;
  font_substitute: string | null;
  element_styles: Record<string, unknown>;
  signature_layout: Record<string, unknown>;
  number_field_layout: Record<string, unknown>;
  watermark_policy: Record<string, unknown>;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  confirmation_status: LayoutConfirmation;
  effective_from: string;
  effective_until: string | null;
  status: LayoutStatus;
  created_by: string;
  approved_by: string | null;
  version: string;
}

const COLUMNS = `id, profile_code, revision, page_size, margins_mm, font_family, font_substitute, element_styles, signature_layout, number_field_layout, watermark_policy, legal_basis, legal_confirmation_ref,
  confirmation_status, effective_from::text as effective_from, effective_until::text as effective_until, status, created_by, approved_by, version::text as version`;

const toDetail = (row: ProfileSql): LayoutProfileDetail => ({
  id: row.id,
  profileCode: row.profile_code,
  revision: row.revision,
  pageSize: row.page_size,
  marginsMm: row.margins_mm,
  fontFamily: row.font_family,
  fontSubstitute: row.font_substitute,
  elementStyles: row.element_styles,
  signatureLayout: row.signature_layout,
  numberFieldLayout: row.number_field_layout,
  watermarkPolicy: row.watermark_policy,
  legalBasis: row.legal_basis,
  legalConfirmationRef: row.legal_confirmation_ref,
  confirmationStatus: row.confirmation_status,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  status: row.status,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (): DomainError => new DomainError('LAYOUT_STATE_INVALID', 409, 'status');
const rangeOverlap = (): DomainError => new DomainError('TEMPLATE_RANGE_OVERLAP', 409, 'effective_from');

function assertDate(value: string, field: string): void {
  const match = DATE.exec(value);
  const date = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (match === null || date === undefined || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw invalid(field);
}

/**
 * The layout profiles of a tenant (ST-DOC-016, DOC F12, BR-DOC-13): the formatting of Appendix I of Decree 30/2020 as data. A revision is drafted by one person with every value inside its legal range (the margins, the
 * sizes of the letters, the place of the seal over the signature of the leader: 422 LAYOUT_OUT_OF_LEGAL_RANGE and nothing written otherwise), and published by another, who takes over from the open-ended revision before it. A
 * published revision never changes but for the day its period ends, and a render reads the revision in force on its date. The database holds the same ranges and the same order (V1228).
 */
export class DocumentLayoutProfileStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<LayoutProfileDetail | undefined> {
    const rows = await tx.query<ProfileSql>(`select ${COLUMNS} from machvon.document_layout_profile where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toDetail(rows[0]);
  }

  /** The revisions by code and revision, narrowed by code and status. */
  async list(tx: TenantTx, filter: LayoutFilter): Promise<LayoutProfileDetail[]> {
    const rows = await tx.query<ProfileSql>(
      `select ${COLUMNS} from machvon.document_layout_profile
        where ($1::text is null or profile_code = $1) and ($2::text is null or status = $2) and ($3::text is null or (profile_code, revision) > ($3::text, $4::int))
        order by profile_code, revision limit $5`,
      [filter.profileCode ?? null, filter.status ?? null, filter.after?.profileCode ?? null, filter.after?.revision ?? null, Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE + 1)],
    );
    return rows.map(toDetail);
  }

  /** The next revision of the code, a draft: every value is judged against the legal ranges first (BR-DOC-13), and a refusal writes nothing. */
  async create(tx: TenantTx, input: NewLayoutRevision): Promise<LayoutProfileDetail> {
    if (!PROFILE_CODE.test(input.profileCode)) throw invalid('profile_code');
    assertDate(input.effectiveFrom, 'effective_from');
    if (input.effectiveUntil !== undefined) {
      assertDate(input.effectiveUntil, 'effective_until');
      if (input.effectiveUntil <= input.effectiveFrom) throw invalid('effective_until');
    }
    const legalBasis = input.legalBasis.trim();
    if (legalBasis === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis');
    if (legalBasis.length > MAX_LEGAL_BASIS) throw invalid('legal_basis');
    const reference = input.legalConfirmationRef === undefined || input.legalConfirmationRef.trim() === '' ? null : input.legalConfirmationRef.trim();
    if (reference !== null && reference.length > MAX_REF) throw invalid('legal_confirmation_ref');
    const fontFamily = input.font_family.trim();
    if (fontFamily.length < 3 || fontFamily.length > 60) throw invalid('font_family');
    await tx.query(CODE_LOCK_SQL, [input.profileCode]);
    const [last] = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.document_layout_profile where profile_code = $1', [input.profileCode]);
    const revision = (last?.revision ?? 0) + 1;
    const profile = layoutFromBody({ ...input, font_family: fontFamily }, input.profileCode, revision);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.document_layout_profile
         (tenant_id, id, profile_code, revision, page_size, margins_mm, font_family, font_substitute, element_styles, signature_layout, number_field_layout, watermark_policy, legal_basis, legal_confirmation_ref,
          confirmation_status, effective_from, effective_until, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, 'PENDING_CONFIRMATION', $14::date, $15::date, 'DRAFT',
          $16::uuid, $16::uuid)`,
      [
        id,
        profile.code,
        profile.revision,
        profile.pageSize,
        JSON.stringify(profile.marginsMm),
        profile.fontFamily,
        profile.fontSubstitute ?? null,
        JSON.stringify(profile.elementStyles),
        JSON.stringify(profile.signatureLayout),
        JSON.stringify(profile.numberFieldLayout),
        JSON.stringify(profile.watermarkPolicy),
        legalBasis,
        reference,
        input.effectiveFrom,
        input.effectiveUntil ?? null,
        input.actor,
      ],
    );
    return this.reread(tx, id);
  }

  /**
   * The approval of a draft by someone other than its drafter (four eyes: 403 SELF_APPROVAL_DENIED). The period must not overlap another published revision of the code: an open-ended revision that starts after an
   * earlier one takes over from it (the earlier one ends on the new start date), any other overlap is 409 TEMPLATE_RANGE_OVERLAP. A revision that is not a draft is 409 LAYOUT_STATE_INVALID.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string): Promise<{ record: LayoutProfileDetail; closed: ClosedProfile[] }> {
    const head = await this.find(tx, id);
    if (head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query(CODE_LOCK_SQL, [head.profileCode]);
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    assertFourEyes(row.createdBy, publisher);
    if (row.status !== 'DRAFT') throw stateInvalid();
    const closed = await this.takeOver(tx, row, publisher);
    try {
      await tx.query("update machvon.document_layout_profile set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, publisher]);
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw rangeOverlap();
      throw error;
    }
    return { record: await this.reread(tx, id), closed };
  }

  private async reread(tx: TenantTx, id: string): Promise<LayoutProfileDetail> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the layout profile vanished after its write');
    return row;
  }

  private async takeOver(tx: TenantTx, row: LayoutProfileDetail, actor: string): Promise<ClosedProfile[]> {
    const overlapping = await tx.query<{ id: string; revision: number; effective_from: string }>(
      `select id, revision, effective_from::text as effective_from from machvon.document_layout_profile
        where profile_code = $1 and status = 'PUBLISHED' and id <> $2::uuid and daterange(effective_from, effective_until, '[)') && daterange($3::date, $4::date, '[)')
        order by effective_from for update`,
      [row.profileCode, row.id, row.effectiveFrom, row.effectiveUntil],
    );
    // Only an open-ended revision takes over from an earlier one; a closed period may not overlap anything.
    if (overlapping.some((earlier) => earlier.effective_from >= row.effectiveFrom) || (row.effectiveUntil !== null && overlapping.length > 0)) throw rangeOverlap();
    const closed: ClosedProfile[] = [];
    for (const earlier of overlapping) {
      await tx.query('update machvon.document_layout_profile set effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [earlier.id, row.effectiveFrom, actor]);
      closed.push({ id: earlier.id, revision: earlier.revision, effectiveUntil: row.effectiveFrom });
    }
    return closed;
  }
}
