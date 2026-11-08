import {
  DomainError,
  EGP_RECONCILE_RULE_CODE,
  EGP_RECONCILE_RULE_TYPE,
  EGP_RESOLUTION_FOLLOW_UP,
  diffEgpRecords,
  egpDifferenceFingerprint,
  egpReconcileParamsOf,
  openReconciliationItems,
  pickReconciliationOwner,
  postingDeadline,
  resolveReconciliationItem,
  versionConflict,
  vietnamDateOf,
  vietnamDayOf,
} from '@machvon/kernel';
import type { EgpFieldDifference, EgpReconciliationItem, EgpResolutionKind, EgpSubjectType, WorkCalendarSource } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface EgpItemRow {
  id: string;
  subjectType: EgpSubjectType;
  subjectId: string;
  subjectCode: string;
  externalCode: string;
  field: string;
  differenceKind: EgpFieldDifference['kind'];
  ours: string | null;
  theirs: string | null;
  delta: string | null;
  fingerprint: string;
  sourceRecordId: string | null;
  importId: string | null;
  state: 'OPEN' | 'RESOLVED';
  ownerId: string;
  makerIds: string[];
  openedBy: string;
  openedAt: string;
  dueAt: string;
  dueAtKey: string;
  resolutionKind: EgpResolutionKind | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  reason: string | null;
  evidenceRef: string | null;
  reviewOn: string | null;
  version: number;
}

interface ItemSql {
  id: string;
  subject_type: EgpSubjectType;
  subject_id: string;
  subject_code: string;
  external_code: string;
  field: string;
  difference_kind: EgpFieldDifference['kind'];
  ours: string | null;
  theirs: string | null;
  delta: string | null;
  fingerprint: string;
  source_record_id: string | null;
  import_id: string | null;
  state: 'OPEN' | 'RESOLVED';
  owner_id: string;
  maker_ids: string[];
  opened_by: string;
  opened_at: string;
  due_at: string;
  due_at_key: string;
  resolution_kind: EgpResolutionKind | null;
  resolved_by: string | null;
  resolved_at: string | null;
  reason: string | null;
  evidence_ref: string | null;
  review_on: string | null;
  version: string;
}

const ITEM_SELECT = `select i.id, i.subject_type, i.subject_id, i.subject_code, i.external_code, i.field, i.difference_kind, i.ours, i.theirs, i.delta, i.fingerprint, i.source_record_id, i.import_id, i.state, i.owner_id, i.maker_ids,
  i.opened_by, to_char(i.opened_at at time zone 'UTC', ${ISO}) as opened_at, to_char(i.due_at at time zone 'UTC', ${ISO}) as due_at, ${timestampKey('i.due_at')} as due_at_key, i.resolution_kind, i.resolved_by,
  to_char(i.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, i.reason, i.evidence_ref, i.review_on::text as review_on, i.version::text as version
  from machvon.egp_reconciliation_item i`;

const itemOf = (row: ItemSql): EgpItemRow => ({
  id: row.id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  subjectCode: row.subject_code,
  externalCode: row.external_code,
  field: row.field,
  differenceKind: row.difference_kind,
  ours: row.ours,
  theirs: row.theirs,
  delta: row.delta,
  fingerprint: row.fingerprint,
  sourceRecordId: row.source_record_id,
  importId: row.import_id,
  state: row.state,
  ownerId: row.owner_id,
  makerIds: row.maker_ids,
  openedBy: row.opened_by,
  openedAt: row.opened_at,
  dueAt: row.due_at,
  dueAtKey: row.due_at_key,
  resolutionKind: row.resolution_kind,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  reason: row.reason,
  evidenceRef: row.evidence_ref,
  reviewOn: row.review_on,
  version: Number(row.version),
});

/** The item as the kernel judges it (the maker-checker rule and the resolutions are the kernel's). */
export const reconciliationItemOf = (row: EgpItemRow): EgpReconciliationItem => ({
  subjectType: row.subjectType,
  subjectKey: row.externalCode,
  field: row.field,
  differenceKind: row.differenceKind,
  ours: row.ours,
  theirs: row.theirs,
  delta: row.delta,
  state: row.state,
  ownerId: row.ownerId,
  makerIds: row.makerIds,
  openedAt: row.openedAt,
  dueAt: row.dueAt,
  resolution:
    row.resolutionKind === null
      ? null
      : { kind: row.resolutionKind, resolvedById: row.resolvedBy as string, resolvedAt: row.resolvedAt as string, reason: row.reason as string, evidenceRef: row.evidenceRef, reviewOn: row.reviewOn },
});

/** The subjects whose imported record the register can be read against, with the table that holds our side. */
const RECONCILED: readonly EgpSubjectType[] = ['PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACTOR'];

interface Compared {
  subjectType: EgpSubjectType;
  subjectId: string;
  subjectCode: string;
  externalCode: string;
  ours: Record<string, string | null>;
  theirs: Record<string, string | null>;
  recordId: string;
  importId: string;
  makerIds: string[];
}

interface MappingSql {
  subject_type: EgpSubjectType;
  subject_id: string;
  external_code: string;
}

interface RecordSql {
  id: string;
  import_id: string;
  applied_by: string;
  record: Record<string, string | number | null>;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : value === null || value === undefined ? null : String(value));
const dayOfInstant = (value: string | null): string | null => (value === null ? null : vietnamDayOf(value));
const unique = (ids: ReadonlyArray<string | null | undefined>): string[] => [...new Set(ids.filter((id): id is string => typeof id === 'string'))];

export interface EgpReconcileOutcome {
  examined: number;
  differences: number;
  opened: number;
  unchanged: number;
  settledAlready: number;
  noOwner: number;
  rows: EgpItemRow[];
}

export interface EgpItemFilter {
  state?: 'OPEN' | 'RESOLVED' | undefined;
  subjectType?: EgpSubjectType | undefined;
  ownerId?: string | undefined;
  subjectId?: string | undefined;
  overdue?: boolean | undefined;
}

/**
 * The reconciliation of our register against what the files of the national procurement network said (EGP-2, BID-26): for each ACTIVE mapping the fields of our record are compared with the imported record
 * (`egp_record`, append-only), field by field (`diffEgpRecords`), and each difference becomes an item with an owner who is not one of the people who made our record or loaded the file, a due time from the
 * rule `EGP_RECONCILIATION_POLICY`, and, once settled, one of four resolutions with the audit of ADM-11 written by the command. Reading the same records again opens nothing new (one open item for a field of a
 * subject, and the fingerprint of both values); a settled difference comes back only when a figure moved or a waiver reaches its review day. A resolution never edits another module's record: the owner of that
 * record changes it through its own command.
 */
export class EgpReconciliationStore {
  private readonly policy = new GovernancePolicyPort();
  private readonly calendars = new HomeWorkCalendars();

  private async ruleDays(tx: TenantTx, now: Date): Promise<{ days: number; version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean }> {
    const rule = await this.policy.require(tx, EGP_RECONCILE_RULE_TYPE, EGP_RECONCILE_RULE_CODE, now);
    return { days: egpReconcileParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>).due_in_working_days, version: rule.version, source: rule.source, unverified: rule.unverified };
  }

  /** The rule of the due time with where its numbers come from (the "i" of the due time). */
  async dueRule(tx: TenantTx, now: Date): Promise<{ days: number; version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null }> {
    const rule = await this.policy.require(tx, EGP_RECONCILE_RULE_TYPE, EGP_RECONCILE_RULE_CODE, now);
    return {
      days: egpReconcileParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>).due_in_working_days,
      version: rule.version,
      source: rule.source,
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
      legalStatus: rule.provenance?.legalStatus ?? null,
    };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<EgpItemRow | undefined> {
    const rows = await tx.query<ItemSql>(`${ITEM_SELECT} where i.id = $1::uuid${lock ? ' for update of i' : ''}`, [id]);
    return rows[0] === undefined ? undefined : itemOf(rows[0]);
  }

  async list(tx: TenantTx, filter: EgpItemFilter, request: { limit: number; after: { key: string; id: string } | undefined }, now: Date): Promise<EgpItemRow[]> {
    const rows = await tx.query<ItemSql>(
      `select * from (${ITEM_SELECT} where ($1::text is null or i.state = $1) and ($2::text is null or i.subject_type = $2) and ($3::uuid is null or i.owner_id = $3::uuid) and ($4::uuid is null or i.subject_id = $4::uuid)
          and (not $5::boolean or (i.state = 'OPEN' and i.due_at < $6::timestamptz))) x
        where ($7::text is null or (x.due_at_key, x.id) > ($7::text, $8::uuid)) order by x.due_at_key, x.id limit $9`,
      [filter.state ?? null, filter.subjectType ?? null, filter.ownerId ?? null, filter.subjectId ?? null, filter.overdue === true, now.toISOString(), request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(itemOf);
  }

  async counts(tx: TenantTx, now: Date): Promise<{ open: number; resolved: number; overdue: number; byResolution: Record<EgpResolutionKind, number>; waiversDue: number }> {
    const rows = await tx.query<{ state: string; resolution_kind: EgpResolutionKind | null; n: string; overdue: string; waivers_due: string }>(
      `select i.state, i.resolution_kind, count(*)::text as n, count(*) filter (where i.state = 'OPEN' and i.due_at < $1::timestamptz)::text as overdue,
              count(*) filter (where i.resolution_kind = 'WAIVE' and i.review_on <= (($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date))::text as waivers_due
         from machvon.egp_reconciliation_item i group by i.state, i.resolution_kind`,
      [now.toISOString()],
    );
    const byResolution = { ACCEPT_EXTERNAL: 0, CORRECT_OURS: 0, DISPUTE: 0, WAIVE: 0 } as Record<EgpResolutionKind, number>;
    let open = 0;
    let resolved = 0;
    let overdue = 0;
    let waiversDue = 0;
    for (const row of rows) {
      if (row.state === 'OPEN') open += Number(row.n);
      else resolved += Number(row.n);
      if (row.resolution_kind !== null) byResolution[row.resolution_kind] += Number(row.n);
      overdue += Number(row.overdue);
      waiversDue += Number(row.waivers_due);
    }
    return { open, resolved, overdue, byResolution, waiversDue };
  }

  // ---- our side and theirs ----------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async latestRecord(tx: TenantTx, kind: string, where: string, params: unknown[]): Promise<RecordSql | undefined> {
    const rows = await tx.query<RecordSql>(`select id, import_id, applied_by, record from machvon.egp_record where kind = $1 and ${where} order by created_at desc, id desc limit 1`, [kind, ...params]);
    return rows[0];
  }

  private async milestones(tx: TenantTx, packageId: string): Promise<{ days: Record<string, string | null>; makers: Array<string | null> }> {
    const rows = await tx.query<{ milestone_kind: string; actual_at: string | null; created_by: string; updated_by: string }>(
      `select milestone_kind, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at, created_by, updated_by from machvon.procurement_milestone where package_id = $1::uuid`,
      [packageId],
    );
    const days: Record<string, string | null> = {};
    for (const row of rows) days[row.milestone_kind] = row.actual_at;
    return { days, makers: rows.flatMap((row) => [row.created_by, row.updated_by]) };
  }

  /** One mapping read against its imported record: only the fields whose value we hold on our side are compared (a field we do not keep is not a difference). */
  private async compare(tx: TenantTx, mapping: MappingSql): Promise<Compared | undefined> {
    const base = { subjectType: mapping.subject_type, subjectId: mapping.subject_id, externalCode: mapping.external_code };
    switch (mapping.subject_type) {
      case 'PACKAGE': {
        const record = await this.latestRecord(tx, 'KHLCNT', "record ->> 'packageExternalCode' = $2", [mapping.external_code]);
        if (record === undefined) return undefined;
        const [ours] = await tx.query<{ code: string; title: string | null; budget: string; method: string; created_by: string | null }>(
          'select code, title, budget_vnd::text as budget, method, created_by from machvon.procurement_package where id = $1::uuid',
          [mapping.subject_id],
        );
        if (ours === undefined) return undefined;
        return {
          ...base,
          subjectCode: ours.code,
          ours: { package_name: ours.title, estimated_price: ours.budget, selection_method: ours.method },
          theirs: { package_name: text(record.record.packageName), estimated_price: text(record.record.estimatedPrice), selection_method: text(record.record.selectionMethod) },
          recordId: record.id,
          importId: record.import_id,
          makerIds: unique([ours.created_by, record.applied_by]),
        };
      }
      case 'PLAN': {
        const record = await this.latestRecord(tx, 'KHLCNT', "record ->> 'planCode' = $2", [mapping.external_code]);
        if (record === undefined) return undefined;
        const [ours] = await tx.query<{ code: string; approved_at: string | null; created_by: string }>(
          `select p.code || '-R' || pl.revision::text as code, to_char(pl.approved_at at time zone 'UTC', ${ISO}) as approved_at, pl.created_by from machvon.procurement_plan pl join machvon.project p on p.tenant_id = pl.tenant_id and p.id = pl.project_id where pl.id = $1::uuid`,
          [mapping.subject_id],
        );
        if (ours === undefined) return undefined;
        return {
          ...base,
          subjectCode: ours.code,
          ours: { approved_on: dayOfInstant(ours.approved_at) },
          theirs: { approved_on: text(record.record.approvedOn) },
          recordId: record.id,
          importId: record.import_id,
          makerIds: unique([ours.created_by, record.applied_by]),
        };
      }
      case 'NOTICE': {
        const record = await this.latestRecord(tx, 'TBMT', "record ->> 'noticeCode' = $2 and record ->> 'noticeKind' <> 'CANCELLATION'", [mapping.external_code]);
        if (record === undefined) return undefined;
        const [pack] = await tx.query<{ code: string }>('select code from machvon.procurement_package where id = $1::uuid', [mapping.subject_id]);
        if (pack === undefined) return undefined;
        const held = await this.milestones(tx, mapping.subject_id);
        return {
          ...base,
          subjectCode: pack.code,
          ours: { published_at: held.days.INVITATION_PUBLISHED ?? null, bid_closing_at: held.days.BID_CLOSING ?? null, bid_opening_at: held.days.BID_OPENING ?? null },
          theirs: { published_at: text(record.record.publishedAt), bid_closing_at: text(record.record.bidClosingAt), bid_opening_at: text(record.record.bidOpeningAt) },
          recordId: record.id,
          importId: record.import_id,
          makerIds: unique([...held.makers, record.applied_by]),
        };
      }
      case 'RESULT': {
        const rows = await tx.query<RecordSql>(`select id, import_id, applied_by, record from machvon.egp_record where kind = 'RESULT' and record ->> 'resultCode' = $1 order by created_at, id`, [mapping.external_code]);
        const record = rows[0];
        if (record === undefined) return undefined;
        const [pack] = await tx.query<{ code: string }>('select code from machvon.procurement_package where id = $1::uuid', [mapping.subject_id]);
        if (pack === undefined) return undefined;
        const [result] = await tx.query<{ outcome: string; award: string | null; tax: string | null; created_by: string; submitted_by: string | null; approved_by: string | null }>(
          `select case r.outcome when 'AWARDED' then 'AWARDED' when 'NO_ACCEPTABLE_BID' then 'NO_QUALIFIED_BID' else 'CANCELLED' end as outcome, r.award_price_vnd::text as award, c.tax_identifier as tax, r.created_by, r.submitted_by, r.approved_by
             from machvon.procurement_result r left join machvon.contractor c on c.tenant_id = r.tenant_id and c.id = r.winner_contractor_id
            where r.package_id = $1::uuid and r.status = 'APPROVED' order by r.approved_at desc, r.id limit 1`,
          [mapping.subject_id],
        );
        const held = await this.milestones(tx, mapping.subject_id);
        // A joint venture or a package of lots has a row for each winner: the winner and the price of one row say nothing about the others, so they are compared only when the result has one row.
        const single = rows.length === 1;
        const ours: Record<string, string | null> = { result_kind: result?.outcome ?? null, published_at: held.days.RESULT_PUBLISHED ?? null };
        const theirs: Record<string, string | null> = { result_kind: text(record.record.resultKind), published_at: text(record.record.publishedAt) };
        if (single) {
          ours.contractor_tax_code = result?.tax ?? null;
          ours.award_price = result?.award ?? null;
          theirs.contractor_tax_code = text(record.record.contractorTaxCode);
          theirs.award_price = text(record.record.awardPrice);
        }
        return {
          ...base,
          subjectCode: pack.code,
          ours,
          theirs,
          recordId: record.id,
          importId: record.import_id,
          makerIds: unique([result?.created_by, result?.submitted_by, result?.approved_by, ...held.makers, ...rows.map((row) => row.applied_by)]),
        };
      }
      case 'CONTRACTOR': {
        const [ours] = await tx.query<{ tax: string; name: string; created_by: string | null }>('select tax_identifier as tax, legal_name as name, created_by from machvon.contractor where id = $1::uuid', [mapping.subject_id]);
        if (ours === undefined) return undefined;
        const record = await this.latestRecord(tx, 'CONTRACTOR', "record ->> 'contractorTaxCode' = $2", [ours.tax]);
        if (record === undefined) return undefined;
        return {
          ...base,
          subjectCode: ours.tax,
          ours: { contractor_name: ours.name },
          theirs: { contractor_name: text(record.record.contractorName) },
          recordId: record.id,
          importId: record.import_id,
          makerIds: unique([ours.created_by, record.applied_by]),
        };
      }
      default:
        return undefined;
    }
  }

  private async latestSettled(tx: TenantTx, subjectType: EgpSubjectType, subjectId: string, field: string, fingerprint: string): Promise<{ resolutionKind: EgpResolutionKind | null; reviewOn: string | null } | undefined> {
    const rows = await tx.query<{ resolution_kind: EgpResolutionKind | null; review_on: string | null }>(
      `select resolution_kind, review_on::text as review_on from machvon.egp_reconciliation_item
        where subject_type = $1 and subject_id = $2::uuid and field = $3 and fingerprint = $4 and state = 'RESOLVED' order by resolved_at desc, id desc limit 1`,
      [subjectType, subjectId, field, fingerprint],
    );
    return rows[0] === undefined ? undefined : { resolutionKind: rows[0].resolution_kind, reviewOn: rows[0].review_on };
  }

  /**
   * Reads every ACTIVE mapping of the given kind of subject (all five when none is named) against its imported record and opens an item for each difference that is not already open or settled. The owner is the person
   * asked for if they are not a maker of the item, else the first holder of `bid.egp.reconcile` on the whole tenant who is not (`pickReconciliationOwner`); with nobody left the difference is counted as `noOwner`
   * and opens nothing (a difference nobody may answer for is a finding for the data steward, not an item that its makers could settle themselves).
   */
  async reconcile(tx: TenantTx, request: { subjectType?: EgpSubjectType | undefined; ownerId: string; holders: readonly string[] }, actor: string, now: Date): Promise<EgpReconcileOutcome> {
    const subjects = request.subjectType === undefined ? RECONCILED : [request.subjectType];
    const due = await this.ruleDays(tx, now);
    const calendars: WorkCalendarSource | undefined = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (calendars === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    const dueAt = postingDeadline({ unit: 'WORKING_DAYS', amount: due.days }, now, calendars);
    const today = vietnamDateOf(now);
    const mappings = await tx.query<MappingSql>(
      `select subject_type, subject_id, external_code from machvon.master_crosswalk
        where subject_type = any($1::text[]) and source_system = 'MUASAMCONG' and status = 'ACTIVE' and valid_from <= $2::date and (valid_until is null or valid_until > $2::date) order by subject_type, external_code, id`,
      [[...subjects], today],
    );
    const outcome: EgpReconcileOutcome = { examined: 0, differences: 0, opened: 0, unchanged: 0, settledAlready: 0, noOwner: 0, rows: [] };
    for (const mapping of mappings) {
      const compared = await this.compare(tx, mapping);
      if (compared === undefined) continue;
      outcome.examined += 1;
      // A field the file leaves empty is not a statement of the network: it is not compared (a column the file does not carry would otherwise flood the worklist with "missing at the network").
      for (const field of Object.keys(compared.theirs)) {
        if (compared.theirs[field] === null) {
          delete compared.theirs[field];
          delete compared.ours[field];
        }
      }
      for (const difference of diffEgpRecords(compared.subjectType, compared.ours, compared.theirs)) {
        outcome.differences += 1;
        const fingerprint = egpDifferenceFingerprint(compared.subjectType, compared.externalCode, difference);
        const open = await tx.query<{ id: string }>(`select id from machvon.egp_reconciliation_item where subject_type = $1 and subject_id = $2::uuid and field = $3 and state = 'OPEN'`, [compared.subjectType, compared.subjectId, difference.field]);
        if (open[0] !== undefined) {
          outcome.unchanged += 1;
          continue;
        }
        const settled = await this.latestSettled(tx, compared.subjectType, compared.subjectId, difference.field, fingerprint);
        if (settled !== undefined && (settled.resolutionKind !== 'WAIVE' || settled.reviewOn === null || settled.reviewOn > today)) {
          outcome.settledAlready += 1;
          continue;
        }
        const ownerId = pickReconciliationOwner([request.ownerId, ...request.holders], compared.makerIds);
        if (ownerId === undefined) {
          outcome.noOwner += 1;
          continue;
        }
        const [item] = openReconciliationItems({ subjectType: compared.subjectType, subjectKey: compared.externalCode, differences: [difference], ownerId, makerIds: compared.makerIds, openedAt: now, dueAt });
        const inserted = await tx.query<{ id: string }>(
          `insert into machvon.egp_reconciliation_item
             (tenant_id, id, subject_type, subject_id, subject_code, external_code, field, difference_kind, ours, theirs, delta, fingerprint, source_record_id, import_id, state, owner_id, maker_ids, opened_by, opened_at, due_at)
           values (${TENANT}, gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, 'OPEN', $13::uuid, $14::uuid[], $15::uuid, $16::timestamptz, $17::timestamptz)
           on conflict do nothing returning id`,
          [
            compared.subjectType,
            compared.subjectId,
            compared.subjectCode,
            compared.externalCode,
            difference.field,
            difference.kind,
            difference.ours,
            difference.theirs,
            difference.delta,
            fingerprint,
            compared.recordId,
            compared.importId,
            ownerId,
            compared.makerIds,
            actor,
            (item as EgpReconciliationItem).openedAt,
            (item as EgpReconciliationItem).dueAt,
          ],
        );
        if (inserted[0] === undefined) {
          outcome.unchanged += 1;
          continue;
        }
        outcome.opened += 1;
        outcome.rows.push((await this.find(tx, inserted[0].id)) as EgpItemRow);
      }
    }
    return outcome;
  }

  /**
   * Settles an item with one of the four resolutions. The kernel judges it (already settled, a maker, the reason, the evidence, the review day) and the database holds the same rules; the version is the `If-Match`.
   * What the resolution asks next is `EGP_RESOLUTION_FOLLOW_UP`: the resolution itself edits nothing of another module.
   */
  async resolve(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    input: { kind: EgpResolutionKind; reason: string; evidenceRef?: string | null | undefined; reviewOn?: string | null | undefined },
    actor: string,
    now: Date,
  ): Promise<{ before: EgpItemRow; row: EgpItemRow; followUp: (typeof EGP_RESOLUTION_FOLLOW_UP)[EgpResolutionKind] }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const done = resolveReconciliationItem(reconciliationItemOf(before), { kind: input.kind, resolvedById: actor, at: now, reason: input.reason, evidenceRef: input.evidenceRef ?? null, reviewOn: input.reviewOn ?? null });
    const resolution = done.resolution as NonNullable<EgpReconciliationItem['resolution']>;
    try {
      await tx.query(
        `update machvon.egp_reconciliation_item set state = 'RESOLVED', resolution_kind = $2, resolved_by = $3::uuid, resolved_at = $4::timestamptz, reason = $5, evidence_ref = $6, review_on = $7::date, version = version + 1, updated_at = now() where id = $1::uuid`,
        [id, resolution.kind, actor, resolution.resolvedAt, resolution.reason, resolution.evidenceRef, resolution.reviewOn],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('EGP_RECONCILIATION_STATE_INVALID', 409, 'state');
      throw error;
    }
    return { before, row: (await this.find(tx, id)) as EgpItemRow, followUp: EGP_RESOLUTION_FOLLOW_UP[resolution.kind] };
  }
}
