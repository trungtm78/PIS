import { createHash } from 'node:crypto';
import {
  DomainError,
  PORTAL_RULE_TYPE,
  assertPortalSlug,
  cutToAllowed,
  oc4idsPackage,
  portalDefaults,
  portalPolicyOf,
  projectPortalRecord,
  validateOc4idsPackage,
  versionConflict,
} from '@machvon/kernel';
import type { Oc4idsIssue, Oc4idsPackage, PortalField, PortalPolicy, PortalProjectFacts, PortalRecord, PublisherInput } from '@machvon/kernel';
import { ISO, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

export interface PortalSettingRow {
  id: string;
  slug: string;
  enabled: boolean;
  whistleEnabled: boolean;
  title: string;
  publisherName: string;
  idPrefix: string;
  licenseUri: string;
  policyUri: string;
  allowedFields: PortalField[];
  ratePerMinute: number;
  pageSizeMax: number;
  policyRuleVersion: number;
  version: number;
  updatedAt: string;
}

export interface PortalRecordRow {
  id: string;
  projectId: string;
  publicCode: string;
  fields: PortalRecord;
  fieldsSha256: string;
  revision: number;
  publishedAt: string;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  version: number;
}

export interface SettingsInput {
  slug: string;
  enabled: boolean;
  whistleEnabled: boolean;
  title: string;
  publisherName: string;
  idPrefix: string;
  licenseUri: string;
  policyUri: string;
}

/** What the public side is allowed to see of a portal: the description and the policy it applies. Nothing else about the tenant. */
export interface PublicInfo {
  title: string;
  publisherName: string;
  idPrefix: string;
  licenseUri: string;
  policyUri: string;
  allowedFields: PortalField[];
  ratePerMinute: number;
  pageSizeMax: number;
  recordCount: number;
  lastPublishedAt: string | null;
}

export interface PublicRecord {
  publicCode: string;
  fields: PortalRecord;
  revision: number;
  publishedAt: string;
}

type Raw = Record<string, unknown>;

const SETTING_COLUMNS = `id, slug, enabled, whistle_enabled, title, publisher_name, id_prefix, license_uri, policy_uri, allowed_fields, rate_per_minute, page_size_max, policy_rule_version, version, ${ISO('updated_at')} as updated_at`;
const toSetting = (row: Raw): PortalSettingRow => ({
  id: row.id as string,
  slug: row.slug as string,
  enabled: row.enabled as boolean,
  whistleEnabled: row.whistle_enabled as boolean,
  title: row.title as string,
  publisherName: row.publisher_name as string,
  idPrefix: row.id_prefix as string,
  licenseUri: row.license_uri as string,
  policyUri: row.policy_uri as string,
  allowedFields: row.allowed_fields as PortalField[],
  ratePerMinute: row.rate_per_minute as number,
  pageSizeMax: row.page_size_max as number,
  policyRuleVersion: row.policy_rule_version as number,
  version: Number(row.version),
  updatedAt: row.updated_at as string,
});

const RECORD_COLUMNS = `id, project_id, public_code, fields, fields_sha256, revision, ${ISO('published_at')} as published_at, ${ISO('withdrawn_at')} as withdrawn_at, withdrawn_reason, version`;
const toRecord = (row: Raw): PortalRecordRow => ({
  id: row.id as string,
  projectId: row.project_id as string,
  publicCode: row.public_code as string,
  fields: row.fields as PortalRecord,
  fieldsSha256: (row.fields_sha256 as string).trim(),
  revision: row.revision as number,
  publishedAt: row.published_at as string,
  withdrawnAt: (row.withdrawn_at as string | null) ?? null,
  withdrawnReason: (row.withdrawn_reason as string | null) ?? null,
  version: Number(row.version),
});

/** The hash of a published record: the fields in the order of the catalogue, so the same record is the same hash. */
export const recordHash = (fields: PortalRecord): string => createHash('sha256').update(JSON.stringify(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');

const SLUG_TAKEN = /PORTAL_SLUG_TAKEN/;

/**
 * The public portal, publisher side (G4-9). The publisher chooses the address and the words of the portal, and publishes a project: the record is cut to the allow-list of the rule in force and stored; the public side reads
 * only those stored rows (V2604). Publishing the same record again changes nothing; a changed record is a new revision; a withdrawn record disappears from the public side at once and stays on the books.
 */
export class PortalStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<PortalPolicy>> {
    return readPolicy(tx, PORTAL_RULE_TYPE, today, portalPolicyOf, portalDefaults);
  }

  async setting(tx: TenantTx, lock = false): Promise<PortalSettingRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${SETTING_COLUMNS} from machvon.portal_setting${lock ? ' for update' : ''}`);
    return row === undefined ? undefined : toSetting(row);
  }

  /** Creates or changes the settings. The policy in force today is copied into them, because the public side cannot read the rules of a tenant; a rule that changes later takes effect at the next save or publication. */
  async saveSettings(tx: TenantTx, input: SettingsInput, expectedVersion: number | undefined, actor: string, today: string): Promise<PortalSettingRow> {
    assertPortalSlug(input.slug);
    const reading = await this.policy(tx, today);
    const current = await this.setting(tx, true);
    try {
      if (current === undefined) {
        if (expectedVersion !== undefined && expectedVersion !== 0) throw versionConflict(0);
        await tx.query(
          `insert into machvon.portal_setting (tenant_id, slug, enabled, whistle_enabled, title, publisher_name, id_prefix, license_uri, policy_uri, allowed_fields, rate_per_minute, page_size_max, policy_rule_version, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13::uuid)`,
          [input.slug, input.enabled, input.whistleEnabled, input.title.trim(), input.publisherName.trim(), input.idPrefix, input.licenseUri.trim(), input.policyUri.trim(), reading.policy.allowed_fields, reading.policy.rate_per_minute, reading.policy.page_size_max, reading.version, actor],
        );
      } else {
        if (expectedVersion !== current.version) throw versionConflict(current.version);
        await tx.query(
          `update machvon.portal_setting set slug = $1, enabled = $2, whistle_enabled = $3, title = $4, publisher_name = $5, id_prefix = $6, license_uri = $7, policy_uri = $8, allowed_fields = $9::text[],
                  rate_per_minute = $10, page_size_max = $11, policy_rule_version = $12, updated_by = $13::uuid, updated_at = now(), version = version + 1`,
          [input.slug, input.enabled, input.whistleEnabled, input.title.trim(), input.publisherName.trim(), input.idPrefix, input.licenseUri.trim(), input.policyUri.trim(), reading.policy.allowed_fields, reading.policy.rate_per_minute, reading.policy.page_size_max, reading.version, actor],
        );
      }
    } catch (error) {
      if (error instanceof Error && SLUG_TAKEN.test(error.message)) throw new DomainError('PORTAL_SLUG_TAKEN', 409, 'slug');
      throw error;
    }
    return (await this.setting(tx)) as PortalSettingRow;
  }

  private async factsOf(tx: TenantTx, projectId: string): Promise<PortalProjectFacts | undefined> {
    const [row] = await tx.query<Raw>(
      `select p.code, p.name, p.status, p.classification, p.project_group, p.total_investment_vnd::text as total, p.start_year, p.end_year,
              to_char(p.updated_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as updated_on, u.name as authority
         from machvon.project p left join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = coalesce(p.investor_unit_id, p.owner_unit_id) where p.id = $1::uuid`,
      [projectId],
    );
    if (row === undefined) return undefined;
    return {
      code: row.code as string,
      name: row.name as string,
      status: row.status as string,
      classification: row.classification as string,
      projectGroup: (row.project_group as string | null) ?? null,
      totalInvestmentVnd: row.total as string,
      startYear: (row.start_year as number | null) ?? null,
      endYear: (row.end_year as number | null) ?? null,
      authorityName: (row.authority as string | null) ?? null,
      updatedOn: row.updated_on as string,
    };
  }

  /** Publishes a project (or a new revision of it) cut to the allow-list of the policy in force; the settings must exist. */
  async publish(tx: TenantTx, projectId: string, input: PublisherInput, actor: string, today: string): Promise<{ record: PortalRecordRow; change: 'CREATED' | 'REVISED' | 'UNCHANGED' | 'RESTORED' }> {
    const setting = await this.setting(tx, true);
    if (setting === undefined) throw new DomainError('PORTAL_NOT_CONFIGURED', 409);
    const facts = await this.factsOf(tx, projectId);
    if (facts === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const reading = await this.policy(tx, today);
    const fields = projectPortalRecord(facts, input, reading.policy.allowed_fields);
    const hash = recordHash(fields);
    const [known] = await tx.query<Raw>(`select ${RECORD_COLUMNS} from machvon.portal_record where project_id = $1::uuid for update`, [projectId]);
    if (known === undefined) {
      await tx.query(
        `insert into machvon.portal_record (tenant_id, project_id, public_code, fields, fields_sha256, published_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::jsonb, $4, $5::uuid)`,
        [projectId, facts.code, JSON.stringify(fields), hash, actor],
      );
      return { record: await this.recordOf(tx, projectId), change: 'CREATED' };
    }
    const existing = toRecord(known);
    if (existing.fieldsSha256 === hash && existing.withdrawnAt === null) return { record: existing, change: 'UNCHANGED' };
    await tx.query(
      `update machvon.portal_record set fields = $2::jsonb, fields_sha256 = $3, revision = revision + 1, published_by = $4::uuid, published_at = now(), public_code = $5, withdrawn_by = null, withdrawn_at = null, withdrawn_reason = null, version = version + 1 where project_id = $1::uuid`,
      [projectId, JSON.stringify(fields), hash, actor, facts.code],
    );
    return { record: await this.recordOf(tx, projectId), change: existing.withdrawnAt === null ? 'REVISED' : 'RESTORED' };
  }

  private async recordOf(tx: TenantTx, projectId: string): Promise<PortalRecordRow> {
    const [row] = await tx.query<Raw>(`select ${RECORD_COLUMNS} from machvon.portal_record where project_id = $1::uuid`, [projectId]);
    return toRecord(row as Raw);
  }

  async withdraw(tx: TenantTx, projectId: string, reason: string, actor: string): Promise<PortalRecordRow> {
    const [row] = await tx.query<Raw>(`select ${RECORD_COLUMNS} from machvon.portal_record where project_id = $1::uuid for update`, [projectId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
    if (toRecord(row).withdrawnAt !== null) throw new DomainError('PORTAL_RECORD_WITHDRAWN', 409);
    if (reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    await tx.query('update machvon.portal_record set withdrawn_by = $2::uuid, withdrawn_at = now(), withdrawn_reason = $3, version = version + 1 where project_id = $1::uuid', [projectId, actor, reason.trim()]);
    return this.recordOf(tx, projectId);
  }

  async records(tx: TenantTx, filter: { includeWithdrawn: boolean; limit: number; offset: number }): Promise<PortalRecordRow[]> {
    const rows = await tx.query<Raw>(`select ${RECORD_COLUMNS} from machvon.portal_record where ($1::boolean or withdrawn_at is null) order by public_code limit $2 offset $3`, [filter.includeWithdrawn, filter.limit, filter.offset]);
    return rows.map(toRecord);
  }

  /** The OC4IDS package of what is published now, cut again by the allow-list in force, with the problems of the standard's required fields: an incomplete package is shown as such and never padded. */
  async exportOc4ids(tx: TenantTx, now: Date): Promise<{ package: Oc4idsPackage; issues: Oc4idsIssue[] } | undefined> {
    const setting = await this.setting(tx);
    if (setting === undefined) return undefined;
    const rows = await tx.query<Raw>(`select ${RECORD_COLUMNS} from machvon.portal_record where withdrawn_at is null order by public_code`);
    const records = rows.map(toRecord).map((row) => cutToAllowed(row.fields as Record<string, unknown>, setting.allowedFields));
    const built = oc4idsPackage({ records, idPrefix: setting.idPrefix, publisher: { name: setting.publisherName }, license: setting.licenseUri, publicationPolicy: setting.policyUri, publishedAt: now });
    return { package: built, issues: validateOc4idsPackage(built) };
  }
}

/** The public reads, run on the control plane through the two functions of V2604: they return only published fields of a portal that is on, and the caller needs no tenant. */
export class PortalPublicReads {
  async info(tx: TenantTx, slug: string): Promise<PublicInfo | undefined> {
    const [row] = await tx.query<Raw>('select * from machvon.portal_public_info($1)', [slug]);
    if (row === undefined) return undefined;
    return {
      title: row.title as string,
      publisherName: row.publisher_name as string,
      idPrefix: row.id_prefix as string,
      licenseUri: row.license_uri as string,
      policyUri: row.policy_uri as string,
      allowedFields: row.allowed_fields as PortalField[],
      ratePerMinute: row.rate_per_minute as number,
      pageSizeMax: row.page_size_max as number,
      recordCount: Number(row.record_count),
      lastPublishedAt: row.last_published_at === null || row.last_published_at === undefined ? null : new Date(row.last_published_at as string).toISOString(),
    };
  }

  async records(tx: TenantTx, slug: string, after: string | null, limit: number): Promise<PublicRecord[]> {
    const rows = await tx.query<Raw>('select * from machvon.portal_public_records($1, $2, $3)', [slug, after, limit]);
    return rows.map((row) => ({ publicCode: row.public_code as string, fields: row.fields as PortalRecord, revision: row.revision as number, publishedAt: new Date(row.published_at as string).toISOString() }));
  }
}
