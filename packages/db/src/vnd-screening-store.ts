import { createHash, randomUUID } from 'node:crypto';
import { DomainError, SCREENING_SOURCES, dismissalExpired, nextHitStatus, screenContractor, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { HitStatus, ListEntry, ScreeningMatch, ScreeningSource } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { Vnd3PolicyReader } from './vnd3-policy.ts';
import { RestrictionCaseStore } from './vendor-restriction-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface HitRow {
  id: string;
  contractorId: string;
  contractorName: string;
  contractorTaxIdentifier: string;
  source: ScreeningSource;
  entryRef: string;
  egpRecordId: string | null;
  listEntryId: string | null;
  entryRowHash: string;
  entryName: string | null;
  entryTaxCode: string | null;
  entryValidFrom: string | null;
  entryValidUntil: string | null;
  score: number;
  basis: string[];
  similarity: number | null;
  hold: boolean;
  status: HitStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  decidedRowHash: string | null;
  caseId: string | null;
  reopenedCount: number;
  version: number;
}

export interface HitEventRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  reason: string | null;
  score: number;
  at: string;
}

export interface RunRow {
  id: string;
  triggerKind: string;
  startedAt: string;
  finishedAt: string;
  contractors: number;
  entries: number;
  hitsNew: number;
  hitsReopened: number;
  hitsResolved: number;
  holds: number;
  policyVersion: string;
  requestedBy: string | null;
}

export interface RunSummary {
  runId: string;
  contractors: number;
  entries: number;
  hitsNew: number;
  hitsReopened: number;
  hitsResolved: number;
  holds: number;
}

export interface SourceState {
  source: ScreeningSource;
  entries: number;
  asOf: string | null;
  reference: string | null;
}

export interface HitFilter {
  status?: string | undefined;
  source?: string | undefined;
  contractorId?: string | undefined;
  limit: number;
}

export interface ListImportInput {
  source: ScreeningSource;
  asOf: string;
  reference: string;
  entries: Array<{ ref: string; name?: string | undefined; taxCode?: string | undefined; validFrom?: string | undefined; validUntil?: string | undefined }>;
}

interface HitSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  contractor_tax_identifier: string;
  source: ScreeningSource;
  entry_ref: string;
  egp_record_id: string | null;
  list_entry_id: string | null;
  entry_row_hash: string;
  entry_name: string | null;
  entry_tax_code: string | null;
  entry_valid_from: string | null;
  entry_valid_until: string | null;
  score: number;
  basis: string[];
  similarity: string | null;
  hold: boolean;
  status: HitStatus;
  first_seen_at: string;
  last_seen_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  decided_row_hash: string | null;
  case_id: string | null;
  reopened_count: number;
  version: number | string;
}

const COLUMNS = `h.id, h.contractor_id, c.legal_name as contractor_name, c.tax_identifier as contractor_tax_identifier, h.source, h.entry_ref, h.egp_record_id, h.list_entry_id, h.entry_row_hash, h.entry_name, h.entry_tax_code,
  h.entry_valid_from::text as entry_valid_from, h.entry_valid_until::text as entry_valid_until, h.score, h.basis, h.similarity::text as similarity, h.hold, h.status, ${timestampKey('h.first_seen_at')} as first_seen_at, ${timestampKey('h.last_seen_at')} as last_seen_at,
  h.decided_by, ${timestampKey('h.decided_at')} as decided_at, h.decision_reason, h.decided_row_hash, h.case_id, h.reopened_count, h.version`;
const FROM = 'machvon.screening_hit h join machvon.contractor c on c.tenant_id = h.tenant_id and c.id = h.contractor_id';

const toHit = (row: HitSql): HitRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  contractorTaxIdentifier: row.contractor_tax_identifier,
  source: row.source,
  entryRef: row.entry_ref,
  egpRecordId: row.egp_record_id,
  listEntryId: row.list_entry_id,
  entryRowHash: row.entry_row_hash,
  entryName: row.entry_name,
  entryTaxCode: row.entry_tax_code,
  entryValidFrom: row.entry_valid_from,
  entryValidUntil: row.entry_valid_until,
  score: row.score,
  basis: row.basis,
  similarity: row.similarity === null ? null : Number(row.similarity),
  hold: row.hold,
  status: row.status,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  decidedRowHash: row.decided_row_hash,
  caseId: row.case_id,
  reopenedCount: row.reopened_count,
  version: Number(row.version),
});

interface EntryRow extends ListEntry {
  egpRecordId: string | null;
  listEntryId: string | null;
}

type Plan =
  | { type: 'new'; contractorId: string; entry: EntryRow; match: ScreeningMatch }
  | { type: 'rescore' | 'touch'; hit: HitSql; entry: EntryRow; match: ScreeningMatch }
  | { type: 'reopen'; hit: HitSql; entry: EntryRow; match: ScreeningMatch }
  | { type: 'resolve'; hit: HitSql; reason: string };

const CASE_OPEN = new Set(['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED']);
const keyOf = (contractorId: string, source: string, ref: string): string => `${contractorId}|${source}|${ref}`;

/**
 * Continuous screening of the registry of contractors against the lists of parties that may not be dealt with (VND-3, V14). The national list is read where the file import keeps it (`egp_record`, kind RESTRICTION); the other
 * lists come in through `importList`. A run compares every contractor with every entry, with the rule `VENDOR_SCREENING` through the kernel, and keeps one hit per contractor and entry: new, rescored, reopened (a dismissal that
 * ran out or whose entry changed), or resolved (the entry left the list, or the case a confirmed hit opened has its decision). A hit above the hold line holds the contractor until a person decides. The screening never bans.
 */
export class VendorScreeningStore {
  private readonly policies = new Vnd3PolicyReader();
  private readonly cases = new RestrictionCaseStore();

  // -- the lists ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async entries(tx: TenantTx): Promise<EntryRow[]> {
    const national = await tx.query<{ id: string; row_hash: string; record: { contractorTaxCode?: string; contractorName?: string | null; validFrom?: string; validUntil?: string } }>("select id, row_hash, record from machvon.egp_record where kind = 'RESTRICTION' order by id");
    const listed = await tx.query<{ id: string; source: ScreeningSource; source_ref: string; name: string | null; tax_code: string | null; valid_from: string | null; valid_until: string | null; row_hash: string }>(
      "select id, source, source_ref, name, tax_code, valid_from::text as valid_from, valid_until::text as valid_until, row_hash from machvon.screening_list_entry where status = 'ACTIVE' order by id",
    );
    return [
      ...national.map((row): EntryRow => ({ source: 'NATIONAL_DEBARMENT', ref: row.id, name: row.record.contractorName ?? null, taxCode: row.record.contractorTaxCode ?? null, validFrom: row.record.validFrom ?? null, validUntil: row.record.validUntil ?? null, rowHash: row.row_hash, egpRecordId: row.id, listEntryId: null })),
      ...listed.map((row): EntryRow => ({ source: row.source, ref: row.source_ref, name: row.name, taxCode: row.tax_code, validFrom: row.valid_from, validUntil: row.valid_until, rowHash: row.row_hash, egpRecordId: null, listEntryId: row.id })),
    ];
  }

  /**
   * Imports a list of parties that may not be dealt with (the multilateral banks, politically exposed persons, a list of the tenant). Idempotent: the same content (its SHA-256) of the same source is imported once. Entries are
   * upserted by source and reference; those a later import of the source no longer lists are withdrawn (kept, never deleted). The caller runs the screening afterwards (trigger LIST_IMPORT).
   */
  async importList(tx: TenantTx, input: ListImportInput, actor: string): Promise<{ importId: string; entries: number; withdrawn: number; replayed: boolean }> {
    if (!SCREENING_SOURCES.includes(input.source) || input.source === 'NATIONAL_DEBARMENT') throw invalid('source');
    if (input.entries.length > 5000) throw invalid('entries');
    // Two imports of one source never run side by side: the replay check and the withdrawals read the latest import.
    await tx.query("select pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':screening-import:' || $1::text, 0))", [input.source]);
    const seen = new Set<string>();
    const prepared = input.entries.map((entry) => {
      const ref = entry.ref.trim();
      const name = entry.name?.trim() === '' ? undefined : entry.name?.trim();
      const taxCode = entry.taxCode?.trim() === '' ? undefined : entry.taxCode?.trim();
      if (ref === '' || seen.has(ref)) throw invalid('entries');
      seen.add(ref);
      if (name === undefined && taxCode === undefined) throw invalid('entries');
      if (entry.validFrom !== undefined && entry.validUntil !== undefined && entry.validUntil < entry.validFrom) throw invalid('entries');
      const rowHash = createHash('sha256').update(JSON.stringify([input.source, ref, name ?? null, taxCode ?? null, entry.validFrom ?? null, entry.validUntil ?? null]), 'utf8').digest('hex');
      return { ref, name: name ?? null, taxCode: taxCode ?? null, validFrom: entry.validFrom ?? null, validUntil: entry.validUntil ?? null, rowHash };
    });
    const content = createHash('sha256').update(JSON.stringify([input.source, prepared.map((entry) => [entry.ref, entry.rowHash]).sort()]), 'utf8').digest('hex');
    const [latest] = await tx.query<{ id: string; entry_count: number; withdrawn_count: number; content_sha256: string }>('select id, entry_count, withdrawn_count, content_sha256 from machvon.screening_list_import where source = $1 order by imported_at desc, id desc limit 1', [input.source]);
    const again = latest?.content_sha256 === content ? latest : undefined;
    if (again !== undefined) return { importId: again.id, entries: again.entry_count, withdrawn: again.withdrawn_count, replayed: true };
    const importId = randomUUID();
    const listed = new Set(prepared.map((entry) => entry.ref));
    const current = await tx.query<{ source_ref: string }>("select source_ref from machvon.screening_list_entry where source = $1 and status = 'ACTIVE'", [input.source]);
    const gone = current.filter((row) => !listed.has(row.source_ref)).map((row) => row.source_ref);
    await tx.query(
      `insert into machvon.screening_list_import (tenant_id, id, source, as_of, reference, content_sha256, entry_count, withdrawn_count, imported_by)
       values (${TENANT}, $1::uuid, $2, $3::date, $4, $5, $6, $7, $8::uuid)`,
      [importId, input.source, input.asOf, input.reference, content, prepared.length, gone.length, actor],
    );
    for (const entry of prepared) {
      await tx.query(
        `insert into machvon.screening_list_entry (tenant_id, source, source_ref, name, tax_code, valid_from, valid_until, row_hash, status, import_id)
         values (${TENANT}, $1, $2, $3, $4, $5::date, $6::date, $7, 'ACTIVE', $8::uuid)
         on conflict (tenant_id, source, source_ref)
         do update set name = excluded.name, tax_code = excluded.tax_code, valid_from = excluded.valid_from, valid_until = excluded.valid_until, row_hash = excluded.row_hash, status = 'ACTIVE', import_id = excluded.import_id, updated_at = now()`,
        [input.source, entry.ref, entry.name, entry.taxCode, entry.validFrom, entry.validUntil, entry.rowHash, importId],
      );
    }
    if (gone.length > 0) await tx.query("update machvon.screening_list_entry set status = 'WITHDRAWN', updated_at = now() where source = $1 and source_ref = any($2::text[])", [input.source, gone]);
    return { importId, entries: prepared.length, withdrawn: gone.length, replayed: false };
  }

  // -- the run -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async run(tx: TenantTx, requestedBy: string | null, trigger: 'NIGHTLY' | 'PROFILE_CHANGE' | 'LIST_IMPORT' | 'MANUAL', now: Date, today: string): Promise<RunSummary> {
    const started = new Date();
    const policy = await this.policies.screening(tx, today);
    const rules = policy.value;
    const contractors = await tx.query<{ id: string; tax_identifier: string; legal_name: string }>('select id, tax_identifier, legal_name from machvon.contractor order by id');
    const entries = await this.entries(tx);
    const entryByKey = new Map(entries.map((entry) => [`${entry.source}|${entry.ref}`, entry]));
    const existing = await tx.query<HitSql>(`select ${COLUMNS} from ${FROM} for update of h`);
    const byKey = new Map(existing.map((row) => [keyOf(row.contractor_id, row.source, row.entry_ref), row]));
    const caseStatus = new Map<string, string>();
    const caseIds = existing.map((row) => row.case_id).filter((id): id is string => id !== null);
    if (caseIds.length > 0) for (const row of await tx.query<{ id: string; status: string }>('select id, status from machvon.restriction_case where id = any($1::uuid[])', [caseIds])) caseStatus.set(row.id, row.status);

    const plan: Plan[] = [];
    const found = new Set<string>();
    for (const contractor of contractors) {
      for (const { entry, match } of screenContractor({ id: contractor.id, taxIdentifier: contractor.tax_identifier, legalName: contractor.legal_name }, entries, today, rules)) {
        const key = keyOf(contractor.id, entry.source, entry.ref);
        found.add(key);
        const hit = byKey.get(key);
        const row = entry as EntryRow;
        if (hit === undefined) plan.push({ type: 'new', contractorId: contractor.id, entry: row, match });
        else if (hit.status === 'DISMISSED') {
          const expired = dismissalExpired({ rowHash: hit.decided_row_hash ?? hit.entry_row_hash, decidedOn: (hit.decided_at ?? hit.last_seen_at).slice(0, 10) }, entry.rowHash, today, rules.dismiss_valid_days);
          plan.push({ type: expired ? 'reopen' : 'touch', hit, entry: row, match });
        } else if (hit.status === 'RESOLVED') plan.push(hit.case_id === null || hit.entry_row_hash !== entry.rowHash ? { type: 'reopen', hit, entry: row, match } : { type: 'touch', hit, entry: row, match });
        else plan.push({ type: 'rescore', hit, entry: row, match });
      }
    }
    for (const hit of existing) {
      const key = keyOf(hit.contractor_id, hit.source, hit.entry_ref);
      if (found.has(key)) {
        if (hit.status === 'CONFIRMED' && hit.case_id !== null && !CASE_OPEN.has(caseStatus.get(hit.case_id) ?? 'PROPOSED')) plan.push({ type: 'resolve', hit, reason: 'the case this hit opened has its decision' });
        continue;
      }
      if (hit.status === 'PENDING' || hit.status === 'CONFIRMED') plan.push({ type: 'resolve', hit, reason: entryByKey.has(`${hit.source}|${hit.entry_ref}`) ? 'the contractor no longer matches the entry' : 'the entry left the list' });
    }
    const count = (type: Plan['type']): number => plan.filter((item) => item.type === type).length;
    const holds = plan.filter((item) => (item.type === 'new' || item.type === 'rescore' || item.type === 'reopen') && item.match.hold).length;
    const runId = randomUUID();
    await tx.query(
      `insert into machvon.screening_run (tenant_id, id, trigger_kind, started_at, finished_at, contractors, entries, hits_new, hits_reopened, hits_resolved, holds, policy_version, requested_by)
       values (${TENANT}, $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12::uuid)`,
      [runId, trigger, started.toISOString(), new Date().toISOString(), contractors.length, entries.length, count('new'), count('reopen'), count('resolve'), holds, policy.version, requestedBy],
    );
    for (const item of plan) await this.apply(tx, runId, item, now);
    return { runId, contractors: contractors.length, entries: entries.length, hitsNew: count('new'), hitsReopened: count('reopen'), hitsResolved: count('resolve'), holds };
  }

  private async event(tx: TenantTx, hitId: string, move: string, from: string | null, to: string, actor: string | null, reason: string | null, score: number, at: Date): Promise<void> {
    await tx.query(
      `insert into machvon.screening_hit_event (tenant_id, hit_id, move, from_status, to_status, actor_id, reason, score, at) values (${TENANT}, $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::timestamptz)`,
      [hitId, move, from, to, actor, reason, score, at.toISOString()],
    );
  }

  private async apply(tx: TenantTx, runId: string, item: Plan, now: Date): Promise<void> {
    const at = now.toISOString();
    if (item.type === 'resolve') {
      nextHitStatus(item.hit.status, 'RESOLVE');
      await tx.query("update machvon.screening_hit set status = 'RESOLVED', hold = false, run_id = $2::uuid, last_seen_at = $3::timestamptz, version = version + 1 where id = $1::uuid", [item.hit.id, runId, at]);
      await this.event(tx, item.hit.id, 'RESOLVE', item.hit.status, 'RESOLVED', null, item.reason, item.hit.score, now);
      return;
    }
    const { entry, match } = item;
    if (item.type === 'new') {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.screening_hit (tenant_id, contractor_id, source, entry_ref, egp_record_id, list_entry_id, entry_row_hash, entry_name, entry_tax_code, entry_valid_from, entry_valid_until, score, basis, similarity, hold, status, run_id, first_seen_at, last_seen_at)
         values (${TENANT}, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9::date, $10::date, $11, $12::text[], $13::numeric, $14, 'PENDING', $15::uuid, $16::timestamptz, $16::timestamptz) returning id`,
        [item.contractorId, entry.source, entry.ref, entry.egpRecordId, entry.listEntryId, entry.rowHash, entry.name, entry.taxCode, entry.validFrom, entry.validUntil, match.score, match.basis, match.similarity, match.hold, runId, at],
      );
      await this.event(tx, (row as { id: string }).id, 'FOUND', null, 'PENDING', null, null, match.score, now);
      return;
    }
    const hit = item.hit;
    const refresh = `entry_row_hash = $3, entry_name = $4, entry_tax_code = $5, entry_valid_from = $6::date, entry_valid_until = $7::date, score = $8, basis = $9::text[], similarity = $10::numeric, hold = $11, run_id = $2::uuid, last_seen_at = $12::timestamptz`;
    const params = [hit.id, runId, entry.rowHash, entry.name, entry.taxCode, entry.validFrom, entry.validUntil, match.score, match.basis, match.similarity, match.hold, at];
    if (item.type === 'reopen') {
      nextHitStatus(hit.status, 'REOPEN');
      await tx.query(`update machvon.screening_hit set ${refresh}, status = 'PENDING', decided_by = null, decided_at = null, decision_reason = null, reopened_count = reopened_count + 1, version = version + 1 where id = $1::uuid`, params);
      await this.event(tx, hit.id, 'REOPEN', hit.status, 'PENDING', null, 'the dismissal ran out or the entry changed', match.score, now);
    } else if (item.type === 'rescore') {
      const changed = hit.score !== match.score || hit.hold !== match.hold || hit.entry_row_hash !== entry.rowHash;
      await tx.query(`update machvon.screening_hit set ${refresh}, version = version + case when $13::boolean then 1 else 0 end where id = $1::uuid`, [...params, changed]);
      if (changed) await this.event(tx, hit.id, 'RESCORED', hit.status, hit.status, null, null, match.score, now);
    } else {
      // A dismissal that still holds, or a resolved hit that did not change: only the day it was last seen moves.
      await tx.query('update machvon.screening_hit set run_id = $2::uuid, last_seen_at = $3::timestamptz where id = $1::uuid', [hit.id, runId, at]);
    }
  }

  // -- the decision --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async locked(tx: TenantTx, id: string, expectedVersion: number): Promise<HitRow> {
    const [row] = await tx.query<HitSql>(`select ${COLUMNS} from ${FROM} where h.id = $1::uuid for update of h`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const hit = toHit(row);
    if (hit.version !== expectedVersion) throw versionConflict(hit.version);
    return hit;
  }

  /**
   * A person confirms the hit. For a hit on the list of the national network the debarment case of VND-1 is opened from its record (trigger EGP_IMPORT, the clock of 15 days starts), so the ban is still decided by the
   * authority on a decision paper by a person other than the one who proposed it; the groups of violation are given by the person (409 RESTRICTION_CASE_DUPLICATE if the record has a case open already). The hold stays until the case has its decision.
   */
  async confirm(tx: TenantTx, id: string, expectedVersion: number, input: { violationGroups?: string[] | undefined; violationSummary?: string | undefined; note?: string | undefined }, actor: string, now: Date): Promise<HitRow> {
    const hit = await this.locked(tx, id, expectedVersion);
    const next = nextHitStatus(hit.status, 'CONFIRM');
    let caseId: string | null = null;
    if (hit.source === 'NATIONAL_DEBARMENT' && hit.egpRecordId !== null) {
      if (input.violationGroups === undefined || input.violationGroups.length === 0) throw invalid('violation_groups');
      const [record] = await tx.query<{ record: { restrictionCode: string; restrictionKind: string; validFrom: string; validUntil: string; decisionNo: string; decisionDate: string | null; legalBasis: string | null } }>('select record from machvon.egp_record where id = $1::uuid', [hit.egpRecordId]);
      const data = (record as NonNullable<typeof record>).record;
      const today = vietnamDateOf(now);
      const summary = input.violationSummary ?? `National network restriction ${data.restrictionCode} (${data.restrictionKind}), decision ${data.decisionNo}, valid ${data.validFrom} to ${data.validUntil}${data.legalBasis === null ? '' : `, basis ${data.legalBasis}`}`;
      const violationOn = [data.decisionDate, data.validFrom].find((day): day is string => day !== null && day <= today) ?? today;
      const opened = await this.cases.open(
        tx,
        { subjectKind: 'CONTRACTOR', contractorId: hit.contractorId, triggerKind: 'EGP_IMPORT', triggerRef: `${data.restrictionCode}/${data.decisionNo}`.slice(0, 200), egpRecordId: hit.egpRecordId, violationGroups: input.violationGroups, violationSummary: summary, violationOn },
        actor,
        now,
      );
      caseId = opened.id;
    }
    await tx.query("update machvon.screening_hit set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, decided_row_hash = entry_row_hash, case_id = $6::uuid, version = version + 1 where id = $1::uuid", [id, next, actor, now.toISOString(), input.note ?? null, caseId]);
    await this.event(tx, id, 'CONFIRM', hit.status, next, actor, input.note ?? null, hit.score, now);
    return (await this.find(tx, id)) as HitRow;
  }

  /** A person dismisses the hit with a reason of at least twenty characters; the hold is lifted and the hit is asked again only when the entry changes or the dismissal runs out. */
  async dismiss(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<HitRow> {
    const hit = await this.locked(tx, id, expectedVersion);
    const next = nextHitStatus(hit.status, 'DISMISS', reason);
    await tx.query('update machvon.screening_hit set status = $2, hold = false, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, decided_row_hash = entry_row_hash, version = version + 1 where id = $1::uuid', [id, next, actor, now.toISOString(), reason.trim()]);
    await this.event(tx, id, 'DISMISS', hit.status, next, actor, reason.trim(), hit.score, now);
    return (await this.find(tx, id)) as HitRow;
  }

  // -- reads ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async find(tx: TenantTx, id: string): Promise<HitRow | undefined> {
    const [row] = await tx.query<HitSql>(`select ${COLUMNS} from ${FROM} where h.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toHit(row);
  }

  async list(tx: TenantTx, filter: HitFilter): Promise<HitRow[]> {
    const params: unknown[] = [];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where = ['true'];
    if (filter.status !== undefined) where.push(`h.status = ${add(filter.status)}`);
    if (filter.source !== undefined) where.push(`h.source = ${add(filter.source)}`);
    if (filter.contractorId !== undefined) where.push(`h.contractor_id = ${add(filter.contractorId)}::uuid`);
    const limit = add(filter.limit);
    const rows = await tx.query<HitSql>(`select ${COLUMNS} from ${FROM} where ${where.join(' and ')} order by (h.status = 'PENDING') desc, h.hold desc, h.score desc, h.first_seen_at, h.id limit ${limit}`, params);
    return rows.map(toHit);
  }

  async events(tx: TenantTx, hitId: string): Promise<HitEventRow[]> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_id: string | null; reason: string | null; score: number; at: string }>(
      `select id, move, from_status, to_status, actor_id, reason, score, ${timestampKey('at')} as at from machvon.screening_hit_event where hit_id = $1::uuid order by at, (move = 'FOUND') desc, id`,
      [hitId],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, reason: row.reason, score: row.score, at: row.at }));
  }

  async runs(tx: TenantTx, limit: number): Promise<RunRow[]> {
    const rows = await tx.query<{ id: string; trigger_kind: string; started_at: string; finished_at: string; contractors: number; entries: number; hits_new: number; hits_reopened: number; hits_resolved: number; holds: number; policy_version: string; requested_by: string | null }>(
      `select id, trigger_kind, ${timestampKey('started_at')} as started_at, ${timestampKey('finished_at')} as finished_at, contractors, entries, hits_new, hits_reopened, hits_resolved, holds, policy_version, requested_by
         from machvon.screening_run order by finished_at desc, id desc limit $1`,
      [limit],
    );
    return rows.map((row) => ({ id: row.id, triggerKind: row.trigger_kind, startedAt: row.started_at, finishedAt: row.finished_at, contractors: row.contractors, entries: row.entries, hitsNew: row.hits_new, hitsReopened: row.hits_reopened, hitsResolved: row.hits_resolved, holds: row.holds, policyVersion: row.policy_version, requestedBy: row.requested_by }));
  }

  /** What each list holds and how fresh it is: the national list is the file import (its latest import day), the others the latest import of their source. */
  async sources(tx: TenantTx): Promise<SourceState[]> {
    const [national] = await tx.query<{ n: number; as_of: string | null }>("select count(*)::int as n, max(created_at)::date::text as as_of from machvon.egp_record where kind = 'RESTRICTION'");
    const listed = await tx.query<{ source: ScreeningSource; entries: number; as_of: string; reference: string }>(
      `select i.source, (select count(*)::int from machvon.screening_list_entry e where e.source = i.source and e.status = 'ACTIVE') as entries, i.as_of::text as as_of, i.reference
         from machvon.screening_list_import i where i.imported_at = (select max(j.imported_at) from machvon.screening_list_import j where j.source = i.source) order by i.source`,
    );
    return [{ source: 'NATIONAL_DEBARMENT', entries: national?.n ?? 0, asOf: national?.as_of ?? null, reference: null }, ...listed.map((row): SourceState => ({ source: row.source, entries: row.entries, asOf: row.as_of, reference: row.reference }))];
  }

  async counts(tx: TenantTx): Promise<{ pending: number; holds: number; confirmed: number; dismissed: number; resolved: number }> {
    const [row] = await tx.query<{ pending: number; holds: number; confirmed: number; dismissed: number; resolved: number }>(
      `select count(*) filter (where status = 'PENDING')::int as pending, count(*) filter (where hold and status in ('PENDING', 'CONFIRMED'))::int as holds, count(*) filter (where status = 'CONFIRMED')::int as confirmed,
              count(*) filter (where status = 'DISMISSED')::int as dismissed, count(*) filter (where status = 'RESOLVED')::int as resolved from machvon.screening_hit`,
    );
    return row ?? { pending: 0, holds: 0, confirmed: 0, dismissed: 0, resolved: 0 };
  }

  /** The time-limit figure of the screening: decided within `decide_within_days` of the day found, over the decided hits plus the pending ones that are past it. */
  async timeliness(tx: TenantTx, decideWithinDays: number, now: Date): Promise<{ inTime: number; late: number; overduePending: number; inTimePct: number | null }> {
    const [row] = await tx.query<{ in_time: number; late: number; overdue: number }>(
      `select count(*) filter (where decided_at is not null and decided_at <= first_seen_at + make_interval(days => $1::int))::int as in_time,
              count(*) filter (where decided_at is not null and decided_at > first_seen_at + make_interval(days => $1::int))::int as late,
              count(*) filter (where status = 'PENDING' and $2::timestamptz > first_seen_at + make_interval(days => $1::int))::int as overdue
         from machvon.screening_hit where status in ('PENDING', 'CONFIRMED', 'DISMISSED', 'RESOLVED') and (decided_at is not null or status = 'PENDING')`,
      [decideWithinDays, now.toISOString()],
    );
    const inTime = row?.in_time ?? 0;
    const late = row?.late ?? 0;
    const overduePending = row?.overdue ?? 0;
    const whole = inTime + late + overduePending;
    return { inTime, late, overduePending, inTimePct: whole === 0 ? null : Math.round((inTime * 1000) / whole) / 10 };
  }

  /** The hits that hold the contractors (or any of the subjects): for the gate and for the alert. */
  async holdsOf(tx: TenantTx, contractorIds: readonly string[]): Promise<Array<{ id: string; contractorId: string; source: ScreeningSource }>> {
    const rows = await tx.query<{ id: string; contractor_id: string; source: ScreeningSource }>(
      "select id, contractor_id, source from machvon.screening_hit where hold and status in ('PENDING', 'CONFIRMED') and contractor_id = any($1::uuid[]) order by score desc, id",
      [[...contractorIds]],
    );
    return rows.map((row) => ({ id: row.id, contractorId: row.contractor_id, source: row.source }));
  }

  /** The open hits for the alert centre, the strongest first. */
  async alertable(tx: TenantTx): Promise<HitRow[]> {
    const rows = await tx.query<HitSql>(`select ${COLUMNS} from ${FROM} where h.status = 'PENDING' order by h.hold desc, h.score desc, h.first_seen_at, h.id limit 200`);
    return rows.map(toHit);
  }
}
