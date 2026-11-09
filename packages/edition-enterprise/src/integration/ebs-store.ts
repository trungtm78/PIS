import { DomainError, addWorkingDays, egpFreshnessParamsOf, subtractDecimal, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { Difference } from '@machvon/kernel';
import { GovernancePolicyPort, HomeWorkCalendars, WORK_CALENDAR_CODE, isActiveMember, normalizeUuid, timestampKey } from '@machvon/db';
import type { ApplyContext, ImportEntry, PreviewableAdapter, TenantTx } from '@machvon/db';
import {
  EBS_FILE_POSITION,
  EBS_FORMAT,
  EBS_LAYOUT_VERSION,
  assertEbsReassign,
  diffEbs,
  ebsFingerprint,
  ebsHealthOf,
  ebsPeriodEnd,
  ebsReconcileParamsOf,
  isEbsPeriod,
  openEbsItems,
  pickEbsOwner,
  resolveEbsItem,
} from './ebs-rules.ts';
import type { EbsDifferenceKind, EbsFigures, EbsItem, EbsMeasure, EbsRecord, EbsResolutionKind } from './ebs-rules.ts';
import { EBS_CODE_SYSTEM } from './project-codes.ts';
import { ProjectCodeResolver } from './project-code-resolver.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const EBS_RECONCILE_RULE_TYPE = 'EBS_RECONCILE_POLICY';
export const EBS_RECONCILE_RULE_CODE = 'DEFAULT';
export const EBS_FRESHNESS_RULE_CODE = 'EBS_FILE';
/** The commitments we hold: the price in force of the contracts that were signed and are not terminated or cancelled (the same statuses as the estimate at completion of CAP); a draft or one in review commits nobody. */
const COMMITTING_STATUSES = ['SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED'];

/** Reads the code of a project through the crosswalk first and the direct match as the fallback for one version (ENT-3e, R25). */
const PROJECT_CODES = new ProjectCodeResolver();

/** What the apply of a valid row does (the dry run says it): keeps the record; or keeps it for a project code the register does not hold, which the reconciliation reports as a difference with an owner. */
export type EbsRowOutcome = 'RECORD' | 'RECORD_PROJECT_UNKNOWN';

/**
 * One kind of file of Oracle EBS for the file import framework (ENT-2): the layout and the judgement of a row are the pure format (`EBS_FORMAT`, layout `WORKING-ASSUMPTION-2026.1`); this half writes what the register
 * keeps. The apply of a row, once per business key ever (the framework claims the key), keeps what the file said as an append-only record. It changes nothing of ours and opens no difference: the comparison with our figures is
 * a command of its own (`EbsReconciliationStore.reconcile`), run by a person who is then one of the makers of what it finds. A valid row is never refused for what the register holds: a project code we do not know is told, not
 * rejected, because the statement of EBS is a fact whether we know the project or not.
 */
export class EbsImportAdapter implements PreviewableAdapter<EbsRecord> {
  readonly connectorCode = EBS_FILE_POSITION;
  readonly formatVersion = EBS_LAYOUT_VERSION;
  /** What the apply wrote, for the audit row and the event of the command. */
  readonly written = { records: 0, unknownProjects: 0 };

  private readonly actor: string;

  constructor(actor: string) {
    this.actor = actor;
  }

  parse = EBS_FORMAT.parse;
  judge = EBS_FORMAT.judge;
  mask = (values: Readonly<Record<string, string>>): Record<string, string> => (EBS_FORMAT.mask === undefined ? {} : EBS_FORMAT.mask(values));

  private async known(tx: TenantTx, projectCode: string): Promise<boolean> {
    return (await PROJECT_CODES.inbound(tx, EBS_CODE_SYSTEM, projectCode, new Date())).projectId !== null;
  }

  async outcomeOf(tx: TenantTx, entry: ImportEntry<EbsRecord>): Promise<EbsRowOutcome> {
    return (await this.known(tx, entry.record.projectCode)) ? 'RECORD' : 'RECORD_PROJECT_UNKNOWN';
  }

  async apply(tx: TenantTx, entry: ImportEntry<EbsRecord>, context: ApplyContext): Promise<readonly Difference[]> {
    const record = entry.record;
    await tx.query(
      `insert into machvon.ebs_record (tenant_id, id, business_key, project_code, period, extract_date, disbursed_vnd, committed_vnd, layout_version, import_id, line, row_hash, applied_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::date, $5::numeric, $6::numeric, $7, $8::uuid, $9, $10, $11::uuid)`,
      [entry.businessKey, record.projectCode, record.period, record.extractDate, record.disbursedVnd, record.committedVnd, this.formatVersion, context.importId, context.line, context.rowHash, this.actor],
    );
    this.written.records += 1;
    if (!(await this.known(tx, record.projectCode))) this.written.unknownProjects += 1;
    return [];
  }

  async ownerFor(): Promise<string | undefined> {
    return undefined;
  }
}

// ---- the reconciliation ----------------------------------------------------------------------------------------------------------------------------

export interface EbsItemRow {
  id: string;
  projectId: string | null;
  projectCode: string;
  period: string;
  measure: EbsMeasure;
  differenceKind: EbsDifferenceKind;
  ours: string | null;
  theirs: string;
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
  resolutionKind: EbsResolutionKind | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  reason: string | null;
  evidenceRef: string | null;
  reviewOn: string | null;
  version: number;
}

interface ItemSql {
  id: string;
  project_id: string | null;
  project_code: string;
  period: string;
  measure: EbsMeasure;
  difference_kind: EbsDifferenceKind;
  ours: string | null;
  theirs: string;
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
  resolution_kind: EbsResolutionKind | null;
  resolved_by: string | null;
  resolved_at: string | null;
  reason: string | null;
  evidence_ref: string | null;
  review_on: string | null;
  version: string;
}

const ITEM_SELECT = `select i.id, i.project_id, i.project_code, i.period, i.measure, i.difference_kind, i.ours::text as ours, i.theirs::text as theirs, i.delta::text as delta, i.fingerprint, i.source_record_id, i.import_id, i.state,
  i.owner_id, i.maker_ids, i.opened_by, to_char(i.opened_at at time zone 'UTC', ${ISO}) as opened_at, to_char(i.due_at at time zone 'UTC', ${ISO}) as due_at, ${timestampKey('i.due_at')} as due_at_key,
  i.resolution_kind, i.resolved_by, to_char(i.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, i.reason, i.evidence_ref, i.review_on::text as review_on, i.version::text as version
  from machvon.ebs_reconciliation_item i`;

const itemOf = (row: ItemSql): EbsItemRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  period: row.period,
  measure: row.measure,
  differenceKind: row.difference_kind,
  ours: plain(row.ours),
  theirs: plain(row.theirs) as string,
  delta: plain(row.delta),
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

/** The item as the pure rules judge it. */
export const ebsItemOf = (row: EbsItemRow): EbsItem => ({
  projectCode: row.projectCode,
  period: row.period,
  measure: row.measure,
  kind: row.differenceKind,
  ours: row.ours,
  theirs: row.theirs,
  delta: row.delta,
  state: row.state,
  ownerId: row.ownerId,
  makerIds: row.makerIds,
  openedAt: row.openedAt,
  dueAt: row.dueAt,
  resolution: row.resolutionKind === null ? null : { kind: row.resolutionKind, resolvedById: row.resolvedBy as string, resolvedAt: row.resolvedAt as string, reason: row.reason as string, evidenceRef: row.evidenceRef, reviewOn: row.reviewOn },
});

export interface EbsReconcileOutcome {
  examined: number;
  differences: number;
  opened: number;
  refreshed: number;
  unchanged: number;
  settledAlready: number;
  noOwner: number;
  rows: EbsItemRow[];
}

export interface EbsItemFilter {
  state?: 'OPEN' | 'RESOLVED' | undefined;
  ownerId?: string | undefined;
  projectCode?: string | undefined;
  period?: string | undefined;
  overdue?: boolean | undefined;
}

interface RecordSql {
  id: string;
  import_id: string;
  applied_by: string;
  project_code: string;
  period: string;
  disbursed_vnd: string | null;
  committed_vnd: string | null;
}

export interface EbsRunRow {
  id: string;
  layoutVersion: string;
  fileSha256: string;
  status: 'IMPORTING' | 'APPLIED' | 'FAILED';
  errorCode: string | null;
  counts: { total: number; applied: number; duplicate: number; conflict: number; quarantined: number; differencesOpened: number };
  importedBy: string;
  createdAt: string;
  completedAt: string | null;
}

/** Whole-dong figures as they are compared: `12345.00` is `12345`. */
const plain = (value: string | null): string | null => (value === null ? null : value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'));

/**
 * The reconciliation of our figures against what the files of Oracle EBS said (ENT-2): for each project code and period of the newest extract, the cumulative disbursement (the Treasury ledger to the end of the period, a
 * reversal taking off) and the commitment (the current effective value of the contracts that commit) are compared with the statement, measure by measure (`diffEbs`), and each difference becomes an item with an owner who is
 * not one of the people who made the figures (whoever loaded the file, whoever ran this), a due time from the rule `EBS_RECONCILE_POLICY` in working days of the published calendar, and, once settled, one of four
 * explanations with the audit of ADM-11 written by the command. Reading the same figures again opens nothing new (one open item for a measure of a project in a period, and the fingerprint of both values); a settled difference
 * comes back only when a figure moved or a timing difference or a waiver reaches the day it is looked at again. The store never edits another module's record.
 */
export class EbsReconciliationStore {
  private readonly policy = new GovernancePolicyPort();
  private readonly calendars = new HomeWorkCalendars();

  async dueRule(tx: TenantTx, now: Date): Promise<{ days: number; version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null }> {
    const rule = await this.policy.require(tx, EBS_RECONCILE_RULE_TYPE, EBS_RECONCILE_RULE_CODE, now);
    return {
      days: ebsReconcileParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>).due_in_working_days,
      version: rule.version,
      source: rule.source,
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
      legalStatus: rule.provenance?.legalStatus ?? null,
    };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<EbsItemRow | undefined> {
    const rows = await tx.query<ItemSql>(`${ITEM_SELECT} where i.id = $1::uuid${lock ? ' for update of i' : ''}`, [normalizeUuid(id, 'id')]);
    return rows[0] === undefined ? undefined : itemOf(rows[0]);
  }

  async list(tx: TenantTx, filter: EbsItemFilter, request: { limit: number; after: { key: string; id: string } | undefined }, now: Date): Promise<EbsItemRow[]> {
    const rows = await tx.query<ItemSql>(
      `select * from (${ITEM_SELECT} where ($1::text is null or i.state = $1) and ($2::uuid is null or i.owner_id = $2::uuid) and ($3::text is null or i.project_code = $3) and ($4::text is null or i.period = $4)
          and (not $5::boolean or (i.state = 'OPEN' and i.due_at < $6::timestamptz))) x
        where ($7::text is null or (x.due_at_key, x.id) > ($7::text, $8::uuid)) order by x.due_at_key, x.id limit $9`,
      [filter.state ?? null, filter.ownerId ?? null, filter.projectCode ?? null, filter.period ?? null, filter.overdue === true, now.toISOString(), request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(itemOf);
  }

  async counts(tx: TenantTx, now: Date): Promise<{ open: number; resolved: number; overdue: number; byResolution: Record<EbsResolutionKind, number>; reviewsDue: number }> {
    const rows = await tx.query<{ state: string; resolution_kind: EbsResolutionKind | null; n: string; overdue: string; reviews_due: string }>(
      `select i.state, i.resolution_kind, count(*)::text as n, count(*) filter (where i.state = 'OPEN' and i.due_at < $1::timestamptz)::text as overdue,
              count(*) filter (where i.resolution_kind in ('TIMING', 'WAIVED') and i.review_on <= (($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date))::text as reviews_due
         from machvon.ebs_reconciliation_item i group by i.state, i.resolution_kind`,
      [now.toISOString()],
    );
    const byResolution = { OURS_WRONG: 0, EBS_WRONG: 0, TIMING: 0, WAIVED: 0 } as Record<EbsResolutionKind, number>;
    let open = 0;
    let resolved = 0;
    let overdue = 0;
    let reviewsDue = 0;
    for (const row of rows) {
      if (row.state === 'OPEN') open += Number(row.n);
      else resolved += Number(row.n);
      if (row.resolution_kind !== null) byResolution[row.resolution_kind] += Number(row.n);
      overdue += Number(row.overdue);
      reviewsDue += Number(row.reviews_due);
    }
    return { open, resolved, overdue, byResolution, reviewsDue };
  }

  /** The members who may answer for a difference: active members holding the right over the whole tenant (a grant on the whole tenant of a role that lists the permission, or its family, or everything). */
  async holdersOf(tx: TenantTx, permission: string, now: Date): Promise<string[]> {
    const family = permission.split('.').slice(0, -1).map((_part, index, parts) => `${parts.slice(0, index + 1).join('.')}.*`);
    const rows = await tx.query<{ membership_id: string }>(
      `select distinct g.membership_id from machvon.role_grant g join machvon.role_definition d on d.tenant_id = g.tenant_id and d.id = g.role_id
        where d.permissions && $2::text[] and d.status = 'Active' and g.scope_kind = 'TENANT' and g.status = 'Active' and g.effective_from <= $1::timestamptz
          and (g.effective_until is null or g.effective_until > $1::timestamptz) and g.revoked_at is null
          and exists (select 1 from machvon.membership m where m.id = g.membership_id and m.status = 'Active' and (m.valid_until is null or m.valid_until > $1::timestamptz))
        order by g.membership_id`,
      [now.toISOString(), [permission, ...family, '*']],
    );
    return rows.map((row) => row.membership_id);
  }

  // ---- our side -------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Our figures for the project a code of EBS stands for, to the end of a period; a measure we hold nothing for is null (no data is not zero). The code is read through the crosswalk of the day `at` first and by
   * direct match against the code of one of our projects after it (ENT-3e, R25), so a code that was reconciled by direct match is read as before.
   */
  async figuresOf(tx: TenantTx, projectCode: string, period: string, at: Date | string = new Date()): Promise<{ projectId: string | null; figures: EbsFigures }> {
    const resolved = await PROJECT_CODES.inbound(tx, EBS_CODE_SYSTEM, projectCode, at);
    const project = resolved.projectId === null ? undefined : { id: resolved.projectId };
    if (project === undefined) return { projectId: null, figures: { DISBURSED_VND: null, COMMITTED_VND: null } };
    const end = ebsPeriodEnd(period);
    const [paid] = await tx.query<{ n: string; vnd: string }>(
      `select count(*)::text as n, coalesce(sum(case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end), 0)::text as vnd
         from machvon.treasury_transaction t where t.project_id = $1::uuid and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date <= $2::date`,
      [project.id, end],
    );
    const [committed] = await tx.query<{ n: string; vnd: string }>(
      `select count(*)::text as n, coalesce(sum(c.contract_value_vnd), 0)::text as vnd from machvon.contract c where c.project_id = $1::uuid and c.status = any($2::text[])`,
      [project.id, COMMITTING_STATUSES],
    );
    return {
      projectId: project.id,
      figures: { DISBURSED_VND: Number(paid?.n ?? 0) === 0 ? null : plain(paid?.vnd ?? null), COMMITTED_VND: Number(committed?.n ?? 0) === 0 ? null : plain(committed?.vnd ?? null) },
    };
  }

  private async latestSettled(tx: TenantTx, projectCode: string, period: string, measure: EbsMeasure, fingerprint: string): Promise<{ resolutionKind: EbsResolutionKind | null; reviewOn: string | null } | undefined> {
    const rows = await tx.query<{ resolution_kind: EbsResolutionKind | null; review_on: string | null }>(
      `select resolution_kind, review_on::text as review_on from machvon.ebs_reconciliation_item
        where project_code = $1 and period = $2 and measure = $3 and fingerprint = $4 and state = 'RESOLVED' order by resolved_at desc, id desc limit 1`,
      [projectCode, period, measure, fingerprint],
    );
    return rows[0] === undefined ? undefined : { resolutionKind: rows[0].resolution_kind, reviewOn: rows[0].review_on };
  }

  /**
   * Reads the newest extract of every project and period (or of one period) against our figures and opens an item for each difference that is not already open or settled. The owner is the person asked for if they are
   * not a maker of the figures, else the first holder of the right to reconcile on the whole tenant who is not (`pickEbsOwner`); with nobody left the difference is counted as `noOwner` and opens nothing (a difference that
   * nobody may answer for is a finding for the data steward, not an item its makers could settle themselves). An open item whose figures moved is refreshed, never duplicated.
   */
  async reconcile(tx: TenantTx, request: { period?: string | undefined; ownerId?: string | undefined; holders: readonly string[] }, actor: string, now: Date): Promise<EbsReconcileOutcome> {
    if (request.period !== undefined && !isEbsPeriod(request.period)) throw new DomainError('VALIDATION_FAILED', 422, 'period');
    // The person asked for must be an active holder of the right to reconcile: nobody else can be made the owner of a difference by naming them.
    const asked = request.ownerId === undefined ? undefined : normalizeUuid(request.ownerId, 'owner_id');
    if (asked !== undefined && !request.holders.includes(asked)) throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
    const due = await this.dueRule(tx, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (calendars === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    const today = vietnamDateOf(now);
    // Working days of the published calendar; the item is due at the end of that day in Vietnam (16:59:59 UTC).
    const dueAt = new Date(`${addWorkingDays(calendars, today, due.days)}T16:59:59.999Z`);
    const records = await tx.query<RecordSql>(
      `select distinct on (project_code, period) id, import_id, applied_by, project_code, period, disbursed_vnd::text as disbursed_vnd, committed_vnd::text as committed_vnd
         from machvon.ebs_record where ($1::text is null or period = $1) order by project_code, period, extract_date desc, created_at desc, id`,
      [request.period ?? null],
    );
    const outcome: EbsReconcileOutcome = { examined: 0, differences: 0, opened: 0, refreshed: 0, unchanged: 0, settledAlready: 0, noOwner: 0, rows: [] };
    for (const record of records) {
      outcome.examined += 1;
      const held = await this.figuresOf(tx, record.project_code, record.period, today);
      const theirs: EbsFigures = { DISBURSED_VND: plain(record.disbursed_vnd), COMMITTED_VND: plain(record.committed_vnd) };
      const differences = diffEbs(held.figures, theirs);
      outcome.differences += differences.length;
      const makers = [...new Set([record.applied_by, actor])];
      for (const difference of differences) {
        const fingerprint = ebsFingerprint({ projectCode: record.project_code, period: record.period, measure: difference.measure, ours: difference.ours, theirs: difference.theirs });
        const [open] = await tx.query<{ id: string; fingerprint: string; owner_id: string; maker_ids: string[] }>(
          "select id, fingerprint, owner_id, maker_ids from machvon.ebs_reconciliation_item where project_code = $1 and period = $2 and measure = $3 and state = 'OPEN' for update",
          [record.project_code, record.period, difference.measure],
        );
        if (open !== undefined) {
          if (open.fingerprint === fingerprint) {
            outcome.unchanged += 1;
            continue;
          }
          // The people who made the new reading join the makers of the item (the makers only grow): the owner of an item cannot settle a difference made of a file they loaded. When the owner
          // is among them now, the item passes to a holder who is not; when nobody is left, the item keeps the reading it has and says so in the counts.
          const refreshedMakers = [...new Set([...open.maker_ids, ...makers])];
          const refreshedOwner = refreshedMakers.includes(open.owner_id) ? pickEbsOwner(request.holders, refreshedMakers, asked) : open.owner_id;
          if (refreshedOwner === undefined) {
            outcome.noOwner += 1;
            continue;
          }
          await tx.query(
            `update machvon.ebs_reconciliation_item set difference_kind = $2, ours = $3::numeric, theirs = $4::numeric, delta = $5::numeric, fingerprint = $6, source_record_id = $7::uuid, import_id = $8::uuid,
                    maker_ids = $10::uuid[], owner_id = $11::uuid, version = version + 1, updated_at = $9::timestamptz
              where id = $1::uuid`,
            [open.id, difference.kind, difference.ours, difference.theirs, difference.delta, fingerprint, record.id, record.import_id, now.toISOString(), refreshedMakers, refreshedOwner],
          );
          outcome.refreshed += 1;
          outcome.rows.push((await this.find(tx, open.id)) as EbsItemRow);
          continue;
        }
        const settled = await this.latestSettled(tx, record.project_code, record.period, difference.measure, fingerprint);
        const reviewDue = settled !== undefined && (settled.resolutionKind === 'TIMING' || settled.resolutionKind === 'WAIVED') && settled.reviewOn !== null && settled.reviewOn <= today;
        if (settled !== undefined && !reviewDue) {
          outcome.settledAlready += 1;
          continue;
        }
        const owner = pickEbsOwner(request.holders, makers, asked);
        if (owner === undefined) {
          outcome.noOwner += 1;
          continue;
        }
        const [item] = openEbsItems({ projectCode: record.project_code, period: record.period, differences: [difference], ownerId: owner, makerIds: makers, openedAt: now, dueAt });
        const inserted = await tx.query<{ id: string }>(
          `insert into machvon.ebs_reconciliation_item (tenant_id, id, project_id, project_code, period, measure, difference_kind, ours, theirs, delta, fingerprint, source_record_id, import_id, state, owner_id, maker_ids, opened_by, opened_at, due_at)
           values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10::uuid, $11::uuid, 'OPEN', $12::uuid, $13::uuid[], $14::uuid, $15::timestamptz, $16::timestamptz)
           returning id`,
          [held.projectId, record.project_code, record.period, (item as EbsItem).measure, (item as EbsItem).kind, difference.ours, difference.theirs, difference.delta, fingerprint, record.id, record.import_id, owner, makers, actor, now.toISOString(), dueAt.toISOString()],
        );
        outcome.opened += 1;
        outcome.rows.push((await this.find(tx, (inserted[0] as { id: string }).id)) as EbsItemRow);
      }
    }
    return outcome;
  }

  /** Explains and closes an item: a stale version is 409 VERSION_CONFLICT; the rules say who may and what each kind of explanation needs. */
  async resolve(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    step: { kind: unknown; reason: unknown; evidenceRef?: unknown; reviewOn?: unknown },
    actor: string,
    now: Date,
  ): Promise<{ before: EbsItemRow; row: EbsItemRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const done = resolveEbsItem(ebsItemOf(before), { ...step, actorId: actor, at: now }, vietnamDateOf(now));
    const resolution = done.resolution;
    if (resolution === null) throw new Error('an item settled by the rules has a resolution');
    await tx.query(
      `update machvon.ebs_reconciliation_item set state = 'RESOLVED', resolution_kind = $2, resolved_by = $3::uuid, resolved_at = $4::timestamptz, reason = $5, evidence_ref = $6, review_on = $7::date, version = version + 1, updated_at = $4::timestamptz
        where id = $1::uuid`,
      [id, resolution.kind, actor, now.toISOString(), resolution.reason, resolution.evidenceRef, resolution.reviewOn],
    );
    return { before, row: (await this.find(tx, id)) as EbsItemRow };
  }

  /** Hands an open item to another active member who is not one of its makers. The due time stays: a handover does not give more time. */
  async reassign(tx: TenantTx, id: string, expectedVersion: number, ownerId: string, now: Date): Promise<{ before: EbsItemRow; row: EbsItemRow }> {
    const owner = normalizeUuid(ownerId, 'owner_id');
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    assertEbsReassign(ebsItemOf(before), owner);
    if (!(await isActiveMember(tx, owner))) throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
    await tx.query('update machvon.ebs_reconciliation_item set owner_id = $2::uuid, version = version + 1, updated_at = $3::timestamptz where id = $1::uuid', [before.id, owner, now.toISOString()]);
    return { before, row: (await this.find(tx, id)) as EbsItemRow };
  }
}

// ---- the connection: runs, health ------------------------------------------------------------------------------------------------------------------

/** The runs of the file import for Oracle EBS, the counts of what it holds and the health of the connection. */
export class EbsConnectionReads {
  private readonly policy = new GovernancePolicyPort();

  async lastRuns(tx: TenantTx, limit: number): Promise<EbsRunRow[]> {
    const rows = await tx.query<{
      id: string;
      format_version: string;
      file_sha256: string;
      status: EbsRunRow['status'];
      error_code: string | null;
      rows_total: number;
      rows_applied: number;
      rows_duplicate: number;
      rows_conflict: number;
      rows_quarantined: number;
      differences_opened: number;
      imported_by: string;
      created_at: string;
      completed_at: string | null;
    }>(
      `select id, format_version, file_sha256, status, error_code, rows_total, rows_applied, rows_duplicate, rows_conflict, rows_quarantined, differences_opened, imported_by,
              to_char(created_at at time zone 'UTC', ${ISO}) as created_at, to_char(completed_at at time zone 'UTC', ${ISO}) as completed_at
         from machvon.file_import where connector_code = $1 order by created_at desc, id desc limit $2`,
      [EBS_FILE_POSITION, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      layoutVersion: row.format_version,
      fileSha256: row.file_sha256,
      status: row.status,
      errorCode: row.error_code,
      counts: { total: row.rows_total, applied: row.rows_applied, duplicate: row.rows_duplicate, conflict: row.rows_conflict, quarantined: row.rows_quarantined, differencesOpened: row.differences_opened },
      importedBy: row.imported_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  /** How many records the register holds of what EBS said, and for how many projects and periods. */
  async recordCounts(tx: TenantTx): Promise<{ records: number; projects: number; periods: number }> {
    const [row] = await tx.query<{ records: string; projects: string; periods: string }>('select count(*)::text as records, count(distinct project_code)::text as projects, count(distinct period)::text as periods from machvon.ebs_record');
    return { records: Number(row?.records ?? 0), projects: Number(row?.projects ?? 0), periods: Number(row?.periods ?? 0) };
  }

  /** The time the last file was applied: the `completed_at` of the newest APPLIED import (the source of the age). */
  async lastImportAt(tx: TenantTx): Promise<Date | undefined> {
    const rows = await tx.query<{ completed_at: string }>("select completed_at from machvon.file_import where connector_code = $1 and status = 'APPLIED' order by completed_at desc limit 1", [EBS_FILE_POSITION]);
    return rows[0] === undefined ? undefined : new Date(rows[0].completed_at);
  }

  /** The health the screen shows and the alert reads: the freshness rule of the code `EBS_FILE`, the age of the last applied file, the alert. */
  async health(tx: TenantTx, now: Date, layoutVersion: string) {
    const rule = await this.policy.require(tx, 'CONNECTOR_FRESHNESS', EBS_FRESHNESS_RULE_CODE, now);
    const params = egpFreshnessParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>);
    const last = await this.lastImportAt(tx);
    const health = ebsHealthOf({ lastImportAt: last ?? null, now, params, layoutVersion });
    return {
      health,
      lastImportAt: last === undefined ? null : last.toISOString(),
      rule: { source: rule.source, version: rule.version, unverified: rule.unverified, formula: rule.provenance?.formula ?? null, sourceText: rule.provenance?.source ?? null, asOf: rule.provenance?.asOf ?? null, legalStatus: rule.provenance?.legalStatus ?? null, params },
    };
  }
}

/** The signed gap `theirs - ours` of two exact decimals, for the screen's sum of differences. */
export const gapOf = (ours: string | null, theirs: string): string | null => (ours === null ? null : subtractDecimal(theirs, ours));
