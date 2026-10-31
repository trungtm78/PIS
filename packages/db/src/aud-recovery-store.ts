import {
  DomainError,
  FINANCIAL_RECOMMENDATION_TYPES,
  MANUAL_SOURCE_KINDS,
  assertWithinRecommendation,
  rateOf,
  remainingToRecover,
  reopensOnReversal,
  wholeDong,
  isInForce,
} from '@machvon/kernel';
import type { PayRecoveryFacts, Rate, RecoverySourceKind } from '@machvon/kernel';
import { AudRecommendationStore } from './aud-recommendation-store.ts';
import type { RecommendationRow } from './aud-recommendation-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const FINANCIAL = new Set<string>(FINANCIAL_RECOMMENDATION_TYPES);
const FINANCIAL_SQL = FINANCIAL_RECOMMENDATION_TYPES.map((type) => `'${type}'`).join(', ');
const NOTE_MIN = 10;
const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

export type ExceptionKind = 'OVER_RECOVERY' | 'UNMATCHED_REVERSAL' | 'NOT_APPLICABLE';

/** A line of the ledger as a command reads it back. */
export interface LinkRow {
  id: string;
  recommendationId: string;
  sourceKind: RecoverySourceKind;
  sourceId: string | null;
  amountVnd: string;
  recordedOn: string;
  evidenceDocumentId: string | null;
  reversalOfId: string | null;
  reversed: boolean;
}

export interface LinkLine {
  id: string;
  recommendationId: string;
  recCode: string;
  sourceKind: RecoverySourceKind;
  sourceId: string | null;
  amountVnd: string;
  recordedOn: string;
  evidenceDocumentId: string | null;
  reversalOfId: string | null;
  reversed: boolean;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
  cumulativeVnd: string;
  remainingVnd: string;
}

export interface ExceptionLine {
  id: string;
  recommendationId: string;
  recCode: string;
  kind: ExceptionKind;
  sourceKind: 'PAY_RECOVERY' | 'PAY_DEDUCTION';
  sourceId: string | null;
  amountVnd: string;
  recordedOn: string;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
}

export interface SummaryLine {
  recommendationId: string;
  recCode: string;
  status: string;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  lineCount: number;
  /** The version of the recommendation, which a line entered by hand is posted under. */
  version: number;
}

export interface RecoverySummary {
  engagementId: string;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  /** What was recovered of what was recommended (BR-AUD-04), with its numerator and denominator. */
  moneyRate: Rate;
  /** The recommendations that are closed of those that are not cancelled, with the numerator and the denominator. */
  countRate: Rate;
  recommendations: SummaryLine[];
  exceptions: ExceptionLine[];
}

/** An engagement of the watch list of AUD-01: what is open and overdue in it and what it recommended and recovered. */
export interface OverviewEngagement {
  id: string;
  code: string;
  title: string;
  status: string;
  recommendationsOpen: number;
  recommendationsOverdue: number;
  amountVnd: string;
  recoveredVnd: string;
}

/** The most engagements the watch list holds: the ones with the most overdue first. */
export const OVERVIEW_ENGAGEMENTS_LIMIT = 50;

export interface Overview {
  engagementsOngoing: number;
  engagementsFollowUp: number;
  recommendationsOpen: number;
  recommendationsOverdue: number;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  moneyRate: Rate;
  countRate: Rate;
  exceptionsOpen: number;
  engagements: OverviewEngagement[];
}

export interface NewLink {
  sourceKind: RecoverySourceKind;
  sourceId: string | undefined;
  amountVnd: string;
  recordedOn: string;
  evidenceDocumentId: string | undefined;
  today: string;
}

/** What the system did with a PAY event. */
export type PayOutcome = { outcome: 'linked' | 'reversed'; linkId: string; recoveredVnd: string; reopened: boolean } | { outcome: 'duplicate' } | { outcome: 'ignored' } | { outcome: 'exception'; kind: ExceptionKind };

interface LinkSql {
  id: string;
  recommendation_id: string;
  rec_code: string;
  source_kind: RecoverySourceKind;
  source_id: string | null;
  amount_vnd: string;
  recorded_on: string;
  evidence_document_id: string | null;
  reversal_of_id: string | null;
  reversed: boolean;
  note: string | null;
  recorded_by: string;
  recorded_at: string;
  cumulative_vnd: string;
  remaining_vnd: string;
}

interface ExceptionSql {
  id: string;
  recommendation_id: string;
  rec_code: string;
  kind: ExceptionKind;
  source_kind: 'PAY_RECOVERY' | 'PAY_DEDUCTION';
  source_id: string | null;
  amount_vnd: string;
  recorded_on: string;
  status: 'OPEN' | 'RESOLVED';
  created_at: string;
}

const toException = (row: ExceptionSql): ExceptionLine => ({
  id: row.id,
  recommendationId: row.recommendation_id,
  recCode: row.rec_code,
  kind: row.kind,
  sourceKind: row.source_kind,
  sourceId: row.source_id,
  amountVnd: row.amount_vnd,
  recordedOn: row.recorded_on,
  status: row.status,
  createdAt: row.created_at,
});

/**
 * The ledger of the recoveries of the financial recommendations (ST-AUD-004, AUD 3.4): a line puts money against a recommendation and moves what was recovered in the same transaction (the
 * table does it, so no writer can leave the two apart); a mistake is put right by a line of the opposite sign, never by changing or deleting one. The recommendation is locked first, so two
 * accountants posting at once are served one after the other and the second may be refused (409). A line that PAY reports and the ledger cannot take is kept as an exception for the accountant.
 */
export class AudRecoveryStore {
  private readonly recommendations = new AudRecommendationStore();

  /** What is on the ledger of a recommendation after a line, read back from the table. */
  private async position(tx: TenantTx, recommendationId: string): Promise<{ amountVnd: string; recoveredVnd: string; status: string; disputeAccepted: boolean }> {
    const [row] = await tx.query<{ amount_vnd: string; recovered_vnd: string; status: string; dispute_outcome: string | null }>(
      'select amount_vnd::text as amount_vnd, recovered_vnd::text as recovered_vnd, status, dispute_outcome from machvon.audit_recommendation where id = $1::uuid',
      [recommendationId],
    );
    const found = row as { amount_vnd: string; recovered_vnd: string; status: string; dispute_outcome: string | null };
    return { amountVnd: found.amount_vnd, recoveredVnd: found.recovered_vnd, status: found.status, disputeAccepted: found.dispute_outcome === 'ACCEPTED_BY_AUTHORITY' };
  }

  /**
   * LINK: a recovery that PAY does not report, entered by an accountant with the document that proves it (422 EVIDENCE_REQUIRED for one that is missing or not in force). The recommendation
   * must be financial (422 RECOMMENDATION_NOT_FINANCIAL) and not cancelled (409), the amount whole dong above zero, the day not in the future; what was recovered never passes what was
   * recommended (409 RECOVERY_EXCEEDS_RECOMMENDATION); a source is linked once (409 RECOVERY_SOURCE_ALREADY_LINKED). PAY's own sources arrive by the events of PAY, not by hand.
   */
  async link(tx: TenantTx, row: RecommendationRow, input: NewLink, actor: string): Promise<{ id: string; recoveredVnd: string; remainingVnd: string; version: number }> {
    if (!FINANCIAL.has(row.recType) || row.amountVnd === null) throw new DomainError('RECOMMENDATION_NOT_FINANCIAL', 422);
    if (row.status === 'CANCELLED') throw new DomainError('RECOMMENDATION_STATE_INVALID', 409, `${row.status}->link`);
    if (!MANUAL_SOURCE_KINDS.includes(input.sourceKind)) throw new DomainError('VALIDATION_FAILED', 422, 'source_kind');
    const amount = wholeDong(input.amountVnd, 'amount_vnd');
    if (amount === '0') throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd');
    if (input.recordedOn > input.today) throw new DomainError('VALIDATION_FAILED', 422, 'recorded_on');
    if (input.evidenceDocumentId === undefined) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_document_id');
    const [document] = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [input.evidenceDocumentId]);
    if (document === undefined || !isInForce(document.effect_status)) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_document_id');
    assertWithinRecommendation({ amountVnd: row.amountVnd, recoveredVnd: row.recoveredVnd }, amount);
    const created = await withUniqueClaim(tx, { constraint: 'audit_recovery_link_source_uq', code: 'RECOVERY_SOURCE_ALREADY_LINKED', status: 409 }, async () => {
      const [line] = await tx.query<{ id: string }>(
        `insert into machvon.audit_recovery_link
           (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, evidence_document_id, recorded_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::numeric, $5::date, $6::uuid, $7::uuid) returning id`,
        [row.id, input.sourceKind, input.sourceId ?? null, amount, input.recordedOn, input.evidenceDocumentId, actor],
      );
      return line as { id: string };
    });
    await this.recommendations.keepEvidence(tx, 'RECOMMENDATION', row.id, input.evidenceDocumentId, 'RECOVERY', actor);
    const after = await this.position(tx, row.id);
    const [updated] = await tx.query<{ version: string }>('select version::text as version from machvon.audit_recommendation where id = $1::uuid', [row.id]);
    return { id: created.id, recoveredVnd: after.recoveredVnd, remainingVnd: remainingToRecover({ amountVnd: after.amountVnd, recoveredVnd: after.recoveredVnd }), version: Number((updated as { version: string }).version) };
  }

  /** Locks the line a reversal is about with its recommendation, in the scope of the caller (404 outside it, 403 when they see it and may not act). */
  async lockLink(tx: TenantTx, linkId: string, seen: ScopeBuilder, acts: ScopeBuilder): Promise<{ link: LinkRow; recommendation: RecommendationRow }> {
    const [located] = await tx.query<{ recommendation_id: string }>('select recommendation_id from machvon.audit_recovery_link where id = $1::uuid', [linkId]);
    if (located === undefined) throw NOT_FOUND();
    // The recommendation is found in the scope of the caller or the line is not there for them; the lock of the recommendation also serves two reversals one after the other.
    const recommendation = await this.recommendations.lock(tx, located.recommendation_id, seen, { acts });
    const [row] = await tx.query<{ id: string; source_kind: RecoverySourceKind; source_id: string | null; amount_vnd: string; recorded_on: string; evidence_document_id: string | null; reversal_of_id: string | null; reversed: boolean }>(
      `select l.id, l.source_kind, l.source_id, l.amount_vnd::text as amount_vnd, l.recorded_on::text as recorded_on, l.evidence_document_id, l.reversal_of_id,
              exists (select 1 from machvon.audit_recovery_link r where r.tenant_id = l.tenant_id and r.reversal_of_id = l.id) as reversed
         from machvon.audit_recovery_link l where l.id = $1::uuid`,
      [linkId],
    );
    if (row === undefined) throw NOT_FOUND();
    return {
      link: { id: row.id, recommendationId: recommendation.id, sourceKind: row.source_kind, sourceId: row.source_id, amountVnd: row.amount_vnd, recordedOn: row.recorded_on, evidenceDocumentId: row.evidence_document_id, reversalOfId: row.reversal_of_id, reversed: row.reversed },
      recommendation,
    };
  }

  /**
   * REVERSE: puts a line of the opposite sign against one that was recorded, with the reason in words (nothing is deleted or changed). A line that was reversed already is 409
   * RECOVERY_ALREADY_REVERSED, and a reversal is not reversed (422). A recommendation that was closed and no longer has everything recovered goes back to IN_PROGRESS (`reopened`).
   */
  async reverse(
    tx: TenantTx,
    target: { link: LinkRow; recommendation: RecommendationRow },
    input: { reason: string | undefined; today: string; day?: string; sourceEventId?: string },
    actor: string,
  ): Promise<{ id: string; recoveredVnd: string; reopened: boolean }> {
    const { link, recommendation } = target;
    if (link.reversalOfId !== null || BigInt(link.amountVnd) <= 0n) throw new DomainError('VALIDATION_FAILED', 422, 'link');
    if (link.reversed) throw new DomainError('RECOVERY_ALREADY_REVERSED', 409);
    const reason = (input.reason ?? '').trim();
    if (input.sourceEventId === undefined && reason.length < NOTE_MIN) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const created = await withUniqueClaim(tx, { constraint: 'audit_recovery_link_reversal_uq', code: 'RECOVERY_ALREADY_REVERSED', status: 409 }, async () => {
      const [line] = await tx.query<{ id: string }>(
        `insert into machvon.audit_recovery_link
           (tenant_id, id, recommendation_id, source_kind, source_id, source_event_id, amount_vnd, recorded_on, evidence_document_id, reversal_of_id, note, recorded_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::numeric, $6::date, $7::uuid, $8::uuid, $9, $10::uuid) returning id`,
        [recommendation.id, link.sourceKind, link.sourceId, input.sourceEventId ?? null, `-${link.amountVnd}`, input.day ?? input.today, link.evidenceDocumentId, link.id, reason === '' ? null : reason, actor],
      );
      return line as { id: string };
    });
    const after = await this.position(tx, recommendation.id);
    // An engagement that is closed keeps the status of its recommendations: the line is the truth of the money, and the engagement is not reopened by a reversal. The engagement is read again
    // under a share lock, after the line took the lock of the recommendation: a closure that is under way finishes first, and one that comes after waits for this reversal and counts what it reopened.
    const [engagement] = await tx.query<{ status: string }>(
      `select e.status from machvon.audit_engagement e join machvon.audit_conclusion c on c.tenant_id = e.tenant_id and c.engagement_id = e.id
         join machvon.audit_recommendation r on r.tenant_id = c.tenant_id and r.conclusion_id = c.id where r.id = $1::uuid for share of e`,
      [recommendation.id],
    );
    const reopened = engagement?.status === 'FOLLOW_UP' && reopensOnReversal({ status: after.status, amountVnd: after.amountVnd, recoveredVnd: after.recoveredVnd, disputeAccepted: after.disputeAccepted });
    if (reopened) {
      await tx.query(
        `update machvon.audit_recommendation
            set status = 'IN_PROGRESS', verified_by = null, verified_at = null, submitted_by = null, reopened_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid`,
        [recommendation.id, actor],
      );
    }
    return { id: created.id, recoveredVnd: after.recoveredVnd, reopened };
  }

  /** Keeps what the ledger could not take as an exception for the accountant, once for each event and kind. */
  private async keepException(tx: TenantTx, recommendationId: string, kind: ExceptionKind, facts: PayRecoveryFacts, eventId: string): Promise<void> {
    await tx.query(
      `insert into machvon.audit_recovery_exception (tenant_id, id, recommendation_id, kind, source_kind, source_id, source_event_id, amount_vnd, recorded_on)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::numeric, $7::date) on conflict do nothing`,
      [recommendationId, kind, facts.sourceKind, facts.recoveryId, eventId, facts.amountVnd, facts.day],
    );
  }

  private async lockForSystem(tx: TenantTx, recommendationId: string): Promise<RecommendationRow | undefined> {
    try {
      return await this.recommendations.lockForSystem(tx, recommendationId);
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * The recovery PAY recorded (`pay.recovery.recorded.v1`): linked once (a second delivery, or the same recovery under another event, is `duplicate`); one that passes what was
   * recommended is kept as an exception and no line is written (`OVER_RECOVERY`); one about a recommendation that takes no money is kept as `NOT_APPLICABLE`; one about a
   * recommendation that is not in the tenant is `ignored`.
   */
  async applyPayRecovery(tx: TenantTx, facts: PayRecoveryFacts, eventId: string, actor: string): Promise<PayOutcome> {
    const row = await this.lockForSystem(tx, facts.recommendationId);
    if (row === undefined) return { outcome: 'ignored' };
    if (!FINANCIAL.has(row.recType) || row.amountVnd === null || row.status === 'CANCELLED') {
      await this.keepException(tx, row.id, 'NOT_APPLICABLE', facts, eventId);
      return { outcome: 'exception', kind: 'NOT_APPLICABLE' };
    }
    const [seen] = await tx.query<{ id: string }>(
      'select id from machvon.audit_recovery_link where (source_event_id = $1::uuid) or (source_kind = $2 and source_id = $3::uuid and amount_vnd > 0)',
      [eventId, facts.sourceKind, facts.recoveryId],
    );
    if (seen !== undefined) return { outcome: 'duplicate' };
    if (BigInt(row.recoveredVnd) + BigInt(facts.amountVnd) > BigInt(row.amountVnd)) {
      await this.keepException(tx, row.id, 'OVER_RECOVERY', facts, eventId);
      return { outcome: 'exception', kind: 'OVER_RECOVERY' };
    }
    const [line] = await tx.query<{ id: string }>(
      `insert into machvon.audit_recovery_link
         (tenant_id, id, recommendation_id, source_kind, source_id, source_event_id, amount_vnd, recorded_on, recorded_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::numeric, $6::date, $7::uuid) returning id`,
      [row.id, facts.sourceKind, facts.recoveryId, eventId, facts.amountVnd, facts.day, actor],
    );
    const after = await this.position(tx, row.id);
    return { outcome: 'linked', linkId: (line as { id: string }).id, recoveredVnd: after.recoveredVnd, reopened: false };
  }

  /**
   * The recovery PAY took back (`pay.recovery.reversed.v1`): one line of the opposite sign against the line of that recovery, once; the recommendation, if it was closed, goes back to
   * work. A reversal of a recovery that was never linked is kept as an exception (`UNMATCHED_REVERSAL`) and changes nothing.
   */
  async applyPayReversal(tx: TenantTx, facts: PayRecoveryFacts, eventId: string, actor: string): Promise<PayOutcome> {
    const row = await this.lockForSystem(tx, facts.recommendationId);
    if (row === undefined) return { outcome: 'ignored' };
    const [seen] = await tx.query<{ id: string }>('select id from machvon.audit_recovery_link where source_event_id = $1::uuid', [eventId]);
    if (seen !== undefined) return { outcome: 'duplicate' };
    const [original] = await tx.query<{ id: string; source_kind: RecoverySourceKind; source_id: string | null; amount_vnd: string; recorded_on: string; evidence_document_id: string | null; reversed: boolean }>(
      `select l.id, l.source_kind, l.source_id, l.amount_vnd::text as amount_vnd, l.recorded_on::text as recorded_on, l.evidence_document_id,
              exists (select 1 from machvon.audit_recovery_link r where r.tenant_id = l.tenant_id and r.reversal_of_id = l.id) as reversed
         from machvon.audit_recovery_link l
        where l.recommendation_id = $1::uuid and l.source_kind = $2 and l.source_id = $3::uuid and l.amount_vnd > 0`,
      [row.id, facts.sourceKind, facts.recoveryId],
    );
    if (original === undefined) {
      await this.keepException(tx, row.id, 'UNMATCHED_REVERSAL', facts, eventId);
      return { outcome: 'exception', kind: 'UNMATCHED_REVERSAL' };
    }
    if (original.reversed) return { outcome: 'duplicate' };
    const done = await this.reverse(
      tx,
      {
        link: { id: original.id, recommendationId: row.id, sourceKind: original.source_kind, sourceId: original.source_id, amountVnd: original.amount_vnd, recordedOn: original.recorded_on, evidenceDocumentId: original.evidence_document_id, reversalOfId: null, reversed: false },
        recommendation: row,
      },
      { reason: undefined, today: facts.day, day: facts.day, sourceEventId: eventId },
      actor,
    );
    return { outcome: 'reversed', linkId: done.id, recoveredVnd: done.recoveredVnd, reopened: done.reopened };
  }

  /** The lines of the ledger of an engagement in the scope of the caller, oldest first, each with what was recovered up to it and what is left after it; none outside the scope. */
  async listLinks(tx: TenantTx, engagementId: string, scope: ScopeBuilder): Promise<LinkLine[]> {
    const predicate = scope(2);
    const rows = await tx.query<LinkSql>(
      `select l.id, l.recommendation_id, r.rec_code, l.source_kind, l.source_id, l.amount_vnd::text as amount_vnd, l.recorded_on::text as recorded_on, l.evidence_document_id, l.reversal_of_id,
              exists (select 1 from machvon.audit_recovery_link x where x.tenant_id = l.tenant_id and x.reversal_of_id = l.id) as reversed, l.note, l.recorded_by, l.recorded_at::text as recorded_at,
              sum(l.amount_vnd) over (partition by l.recommendation_id order by l.recorded_at, l.id)::text as cumulative_vnd,
              (r.amount_vnd - sum(l.amount_vnd) over (partition by l.recommendation_id order by l.recorded_at, l.id))::text as remaining_vnd
         from machvon.audit_recovery_link l
         join machvon.audit_recommendation r on r.tenant_id = l.tenant_id and r.id = l.recommendation_id
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
        where c.engagement_id = $1::uuid and ${predicate.sql}
        order by l.recorded_at, l.id`,
      [engagementId, ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      recommendationId: row.recommendation_id,
      recCode: row.rec_code,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      amountVnd: row.amount_vnd,
      recordedOn: row.recorded_on,
      evidenceDocumentId: row.evidence_document_id,
      reversalOfId: row.reversal_of_id,
      reversed: row.reversed,
      note: row.note,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
      cumulativeVnd: row.cumulative_vnd,
      remainingVnd: row.remaining_vnd,
    }));
  }

  /**
   * The money of an engagement and the rates of its recommendations (BR-AUD-04), each with its numerator and its denominator, per recommendation, with the exceptions that are open;
   * undefined when the engagement does not exist or lies outside the scope of the caller.
   */
  async summary(tx: TenantTx, engagementId: string, scope: ScopeBuilder): Promise<RecoverySummary | undefined> {
    const predicate = scope(2);
    const [located] = await tx.query<{ id: string }>(`select e.id from machvon.audit_engagement e where e.id = $1::uuid and ${predicate.sql}`, [engagementId, ...predicate.params]);
    if (located === undefined) return undefined;
    const lines = await tx.query<{ recommendation_id: string; rec_code: string; status: string; amount_vnd: string; recovered_vnd: string; line_count: string; version: string }>(
      `select r.id as recommendation_id, r.rec_code, r.status, r.amount_vnd::text as amount_vnd, r.recovered_vnd::text as recovered_vnd, r.version::text as version,
              (select count(*) from machvon.audit_recovery_link l where l.tenant_id = r.tenant_id and l.recommendation_id = r.id)::text as line_count
         from machvon.audit_recommendation r join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
        where c.engagement_id = $1::uuid and r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'
        order by r.rec_code, r.id`,
      [engagementId],
    );
    const [counts] = await tx.query<{ closed: string; counted: string }>(
      `select count(*) filter (where r.status = 'CLOSED')::text as closed, count(*) filter (where r.status <> 'CANCELLED')::text as counted
         from machvon.audit_recommendation r join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id where c.engagement_id = $1::uuid`,
      [engagementId],
    );
    const exceptions = await tx.query<ExceptionSql>(
      `select x.id, x.recommendation_id, r.rec_code, x.kind, x.source_kind, x.source_id, x.amount_vnd::text as amount_vnd, x.recorded_on::text as recorded_on, x.status, x.created_at::text as created_at
         from machvon.audit_recovery_exception x join machvon.audit_recommendation r on r.tenant_id = x.tenant_id and r.id = x.recommendation_id
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
        where c.engagement_id = $1::uuid and x.status = 'OPEN' order by x.created_at, x.id`,
      [engagementId],
    );
    const amount = lines.reduce((sum, line) => sum + BigInt(line.amount_vnd), 0n).toString();
    const recovered = lines.reduce((sum, line) => sum + BigInt(line.recovered_vnd), 0n).toString();
    return {
      engagementId,
      amountVnd: amount,
      recoveredVnd: recovered,
      remainingVnd: remainingToRecover({ amountVnd: amount, recoveredVnd: recovered }),
      moneyRate: rateOf(recovered, amount),
      countRate: rateOf(counts?.closed ?? '0', counts?.counted ?? '0'),
      recommendations: lines.map((line) => ({
        recommendationId: line.recommendation_id,
        recCode: line.rec_code,
        status: line.status,
        amountVnd: line.amount_vnd,
        recoveredVnd: line.recovered_vnd,
        remainingVnd: remainingToRecover({ amountVnd: line.amount_vnd, recoveredVnd: line.recovered_vnd }),
        lineCount: Number(line.line_count),
        version: Number(line.version),
      })),
      exceptions: exceptions.map(toException),
    };
  }

  /** The figures of AUD-01 over every engagement in the scope of the caller: the engagements being worked, the recommendations still open and overdue, the money and the two rates. */
  async overview(tx: TenantTx, scope: ScopeBuilder, today: string): Promise<Overview> {
    const alone = scope(1);
    const predicate = scope(2);
    const [engagements] = await tx.query<{ ongoing: string; follow_up: string }>(
      `select count(*) filter (where e.status in ('ONGOING', 'AWAITING_CONCLUSION'))::text as ongoing, count(*) filter (where e.status = 'FOLLOW_UP')::text as follow_up
         from machvon.audit_engagement e where ${alone.sql}`,
      alone.params,
    );
    const [recommendations] = await tx.query<{ open: string; overdue: string; counted: string; closed: string; amount: string; recovered: string }>(
      `select count(*) filter (where r.status not in ('CLOSED', 'CANCELLED'))::text as open,
              count(*) filter (where r.status not in ('CLOSED', 'CANCELLED', 'DISPUTED') and r.due_on is not null and r.due_on < $1::date)::text as overdue,
              count(*) filter (where r.status <> 'CANCELLED')::text as counted, count(*) filter (where r.status = 'CLOSED')::text as closed,
              coalesce(sum(r.amount_vnd) filter (where r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'), 0)::text as amount,
              coalesce(sum(r.recovered_vnd) filter (where r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'), 0)::text as recovered
         from machvon.audit_recommendation r join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
        where ${predicate.sql}`,
      [today, ...predicate.params],
    );
    const [exceptions] = await tx.query<{ open: string }>(
      `select count(*)::text as open from machvon.audit_recovery_exception x join machvon.audit_recommendation r on r.tenant_id = x.tenant_id and r.id = x.recommendation_id
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
        where x.status = 'OPEN' and ${alone.sql}`,
      alone.params,
    );
    const watched = await tx.query<{ id: string; engagement_code: string; title: string; status: string; open: string; overdue: string; amount: string; recovered: string }>(
      `select e.id, e.engagement_code, e.title, e.status,
              count(r.id) filter (where r.status not in ('CLOSED', 'CANCELLED'))::text as open,
              count(r.id) filter (where r.status not in ('CLOSED', 'CANCELLED', 'DISPUTED') and r.due_on is not null and r.due_on < $1::date)::text as overdue,
              coalesce(sum(r.amount_vnd) filter (where r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'), 0)::text as amount,
              coalesce(sum(r.recovered_vnd) filter (where r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'), 0)::text as recovered
         from machvon.audit_engagement e
         left join machvon.audit_conclusion c on c.tenant_id = e.tenant_id and c.engagement_id = e.id
         left join machvon.audit_recommendation r on r.tenant_id = c.tenant_id and r.conclusion_id = c.id
        where e.status in ('ONGOING', 'AWAITING_CONCLUSION', 'FOLLOW_UP') and ${predicate.sql}
        group by e.id, e.engagement_code, e.title, e.status
        order by count(r.id) filter (where r.status not in ('CLOSED', 'CANCELLED', 'DISPUTED') and r.due_on is not null and r.due_on < $1::date) desc, e.engagement_code, e.id
        limit ${OVERVIEW_ENGAGEMENTS_LIMIT}`,
      [today, ...predicate.params],
    );
    const money = recommendations as { open: string; overdue: string; counted: string; closed: string; amount: string; recovered: string };
    return {
      engagementsOngoing: Number(engagements?.ongoing ?? 0),
      engagementsFollowUp: Number(engagements?.follow_up ?? 0),
      recommendationsOpen: Number(money.open),
      recommendationsOverdue: Number(money.overdue),
      amountVnd: money.amount,
      recoveredVnd: money.recovered,
      remainingVnd: remainingToRecover({ amountVnd: money.amount, recoveredVnd: money.recovered }),
      moneyRate: rateOf(money.recovered, money.amount),
      countRate: rateOf(money.closed, money.counted),
      exceptionsOpen: Number(exceptions?.open ?? 0),
      engagements: watched.map((row) => ({ id: row.id, code: row.engagement_code, title: row.title, status: row.status, recommendationsOpen: Number(row.open), recommendationsOverdue: Number(row.overdue), amountVnd: row.amount, recoveredVnd: row.recovered })),
    };
  }
}
